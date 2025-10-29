// check-once.js — HyperDash → Telegram
// Алерты: открытие/закрытие позиции, изменение размера (в монетах),
// и плановый отчёт раз в HEARTBEAT_HOURS часов.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const TRADER_URL =
  process.env.TRADER_URL ||
  "https://hyperdash.info/trader/0xc2a30212a8DdAc9e123944d6e29FADdCe994E5f2";

const STATE_FILE = path.join(process.cwd(), "state-keys.json");

const TELEGRAM_TOKEN =
  process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const EXEC_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";

const SIZE_TOL = parseFloat(process.env.SIZE_TOL || "0");
const SIZE_TOL_REL = parseFloat(process.env.SIZE_TOL_REL || "0");
const HEARTBEAT_HOURS = parseFloat(process.env.HEARTBEAT_HOURS || "4");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const MAX = 3900;
  for (let i = 0; i < text.length; i += MAX) {
    const chunk = text.slice(i, i + MAX);
    const body = new URLSearchParams({
      chat_id: TELEGRAM_CHAT_ID,
      text: chunk,
      disable_web_page_preview: "true",
    });
    const res = await fetch(url, { method: "POST", body });
    const txt = await res.text();
    if (!res.ok) {
      console.error("Telegram error:", res.status, txt);
      throw new Error("Telegram send failed");
    }
  }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { keys: [], sizes: {}, lastHeartbeat: 0 }; }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function uniq(a){ return [...new Set(a)]; }
function num(x){
  if (x == null) return null;
  // удаляем обычные пробелы, NBSP (U+00A0) и узкие NBSP (U+202F), а также запятые
  const n = Number(String(x).replace(/[ \u00A0\u202F,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function diffKeys(prevArr, curArr){
  const prev = new Set(prevArr || []);
  const cur = new Set(curArr || []);
  return { added: [...cur].filter(x=>!prev.has(x)),
           removed: [...prev].filter(x=>!cur.has(x)) };
}
function changedEnough(oldV, newV){
  if (oldV == null || newV == null) return false;
  const abs = Math.abs(newV - oldV);
  const rel = oldV !== 0 ? abs / Math.abs(oldV) : (abs > 0 ? Infinity : 0);
  if (SIZE_TOL > 0 && abs > SIZE_TOL) return true;
  if (SIZE_TOL_REL > 0 && rel > SIZE_TOL_REL) return true;
  return (SIZE_TOL === 0 && SIZE_TOL_REL === 0) ? abs > 0 : false;
}
function fmt(n, p = 2){
  if (n == null || !Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: p });
  return n.toFixed(6);
}

// ── из __NEXT_DATA__
function extractFromNextData(json){
  const pos = [];
  function* walk(o){
    if (Array.isArray(o)) for (const v of o) yield* walk(v);
    else if (o && typeof o === "object") {
      yield o;
      for (const v of Object.values(o)) yield* walk(v);
    }
  }
  for (const o of walk(json)){
    const symbol = o.symbol || o.asset || o.coin || o.name;
    let side = null;
    if (typeof o.isLong === "boolean") side = o.isLong ? "LONG" : "SHORT";
    else if (o.side) side = String(o.side).toUpperCase();

    const sizeCandidates = [
      o.baseSize, o.qty, o.contracts, o.szi, o.sz, o.positionSize, o.coinSize,
    ].map(num).filter(x=>x!=null);

    if (symbol && (side==="LONG"||side==="SHORT") &&
        /^[A-Z0-9.\-:]{2,15}$/.test(String(symbol).toUpperCase())){
      const key = `${String(symbol).toUpperCase()}:${side}`;
      const sizeCoin = sizeCandidates.length ? Math.abs(sizeCandidates[0]) : null;
      pos.push({ key, symbol: String(symbol).toUpperCase(), side, sizeCoin });
    }
  }
  const map = new Map();
  for (const p of pos) map.set(p.key, p);
  return [...map.values()];
}

// ── фолбэк по тексту
function extractFromText(lines){
  const items = [];
  for (const raw of lines){
    const s = (raw || "").toUpperCase();
    let mKey =
      s.match(/^\s*([A-Z0-9.\-:]{2,15})\s+\d+x.*\b(LONG|SHORT)\b/) ||
      s.match(/^\s*([A-Z0-9.\-:]{2,15})\s*[| ].*?\b(LONG|SHORT)\b/);
    if (!mKey) continue;
    const symbol = mKey[1].toUpperCase();
    const side = mKey[2].toUpperCase();
    if (symbol==="ASSET" || symbol==="TYPE") continue;
    const key = `${symbol}:${side}`;

    const rx = new RegExp(`([0-9][0-9.,\\s\\u00A0\\u202F]+)\\s+${symbol}\\b`);
    const mSize = s.match(rx);
    const sizeCoin = mSize ? num(mSize[1]) : null;

    items.push({ key, symbol, side, sizeCoin });
  }
  const map = new Map();
  for (const p of items) map.set(p.key, p);
  return [...map.values()];
}

// ── основной парсер позиций
async function getPositions(browser){
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  );
  await page.setViewport({ width: 1366, height: 900 });
  await page.goto(TRADER_URL, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(2500);

  // 0) Парсим реальную таблицу (Asset / Type / Position Value / Size)
  const byTable = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    function pickTable() {
      for (const t of Array.from(document.querySelectorAll("table"))) {
        const head = norm(t.tHead?.innerText || t.querySelector("thead")?.innerText || "");
        if (/asset/i.test(head) && /type/i.test(head) && /(position\s*value|size)/i.test(head)) {
          return t;
        }
      }
      for (const t of Array.from(document.querySelectorAll('[role="table"]'))) {
        const head = norm(
          t.querySelector('[role="rowgroup"]')?.innerText ||
          t.querySelector("thead")?.innerText || ""
        );
        if (/asset/i.test(head) && /type/i.test(head) && /(position\s*value|size)/i.test(head)) {
          return t;
        }
      }
      return null;
    }

    const tbl = pickTable();
    if (!tbl) return null;

    const rows = Array.from(tbl.querySelectorAll("tbody tr"));
    const out = [];

    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length < 3) continue;

      const assetRaw = norm(tds[0].innerText).toUpperCase();
      const asset = (assetRaw.match(/^([A-Z0-9.\-:]{2,15})/) || [])[1];
      if (!asset) continue;

      const typeText = norm(tds[1].innerText).toUpperCase();
      const side = /SHORT/.test(typeText) ? "SHORT" : /LONG/.test(typeText) ? "LONG" : null;
      if (!side) continue;

      const rowTxt = norm(tr.textContent).toUpperCase();
      const rx = new RegExp(`([0-9][0-9.,\\s\\u00A0\\u202F]+)\\s*${asset}\\b`);

      let sizeCoin = null;
      let mRow = rowTxt.match(rx);
      if (mRow) {
        sizeCoin = Number(mRow[1].replace(/[ \u00A0\u202F,]/g, ""));
      } else {
        const pv = norm(tds[2].innerText).toUpperCase();
        const m = pv.match(rx);
        sizeCoin = m ? Number(m[1].replace(/[ \u00A0\u202F,]/g, "")) : null;
      }

      out.push({ key: `${asset}:${side}`, symbol: asset, side, sizeCoin });
    }
    return out;
  });

  if (byTable && byTable.length) { await page.close(); return byTable; }

  // 1) __NEXT_DATA__
  const nextTxt = await page.evaluate(() => {
    const el = document.querySelector("#__NEXT_DATA__");
    return el ? el.textContent : null;
  });
  if (nextTxt) {
    try {
      const json = JSON.parse(nextTxt);
      const pos = (function extractFromNextData(json){
        const res = [];
        function* walk(o){
          if (Array.isArray(o)) for (const v of o) yield* walk(v);
          else if (o && typeof o === "object") {
            yield o;
            for (const v of Object.values(o)) yield* walk(v);
          }
        }
        for (const o of walk(json)){
          const symbol = o.symbol || o.asset || o.coin || o.name;
          let side = null;
          if (typeof o.isLong === "boolean") side = o.isLong ? "LONG" : "SHORT";
          else if (o.side) side = String(o.side).toUpperCase();

          const sizeCandidates = [
            o.baseSize, o.qty, o.contracts, o.szi, o.sz, o.positionSize, o.coinSize,
          ].map(x => {
            if (x == null) return null;
            return Number(String(x).replace(/[ \u00A0\u202F,]/g, ""));
          }).filter(x=>Number.isFinite(x));

          if (symbol && (side==="LONG"||side==="SHORT") &&
              /^[A-Z0-9.\-:]{2,15}$/.test(String(symbol).toUpperCase())){
            const key = `${String(symbol).toUpperCase()}:${side}`;
            const sizeCoin = sizeCandidates.length ? Math.abs(sizeCandidates[0]) : null;
            res.push({ key, symbol: String(symbol).toUpperCase(), side, sizeCoin });
          }
        }
        const map = new Map();
        for (const p of res) map.set(p.key, p);
        return [...map.values()];
      })(json);

      if (pos.length){ await page.close(); return pos; }
    } catch {}
  }

  // 2) фолбэк по тексту
  const lines = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const roots = [];
    document.querySelectorAll("*").forEach((el) => {
      const t = (el.textContent || "").toLowerCase();
      if (t.includes("asset positions") || t === "positions") {
        const r = el.closest("section") || el.parentElement || el;
        if (r) roots.push(r);
      }
    });
    roots.push(
      document.querySelector("[data-testid*='positions']"),
      document.querySelector(".open-positions"),
      document.querySelector("#positions")
    );
    const harvest = (root) => {
      if (!root) return [];
      const tbl = Array.from(root.querySelectorAll("tr"))
        .map((r) =>
          Array.from(r.querySelectorAll("th,td"))
            .map((td) => norm(td.innerText))
            .filter(Boolean)
            .join(" | ")
        )
        .filter(Boolean);
      const rows = Array.from(root.querySelectorAll("li,[role='row'],.row"))
        .map((n) => norm(n.innerText))
        .filter(Boolean);
      return [...new Set([...tbl, ...rows])];
    };
    return [...new Set(roots.filter(Boolean).flatMap(harvest))];
  });

  await page.close();
  return extractFromText(lines);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: EXEC_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--no-zygote",
    ],
  });

  try {
    const prev = loadState(); // { keys:[], sizes:{}, lastHeartbeat }
    const curr = await getPositions(browser);

    const keys = uniq(curr.map(p => p.key)).sort();
    const { added, removed } = diffKeys(prev.keys, keys);

    const resized = [];
    for (const p of curr) {
      if (prev.keys.includes(p.key)) {
        const oldV = prev.sizes?.[p.key];
        const newV = p.sizeCoin != null ? p.sizeCoin : oldV;
        if (newV != null && oldV != null && changedEnough(oldV, newV)) {
          const delta = newV - oldV;
          const rel = oldV !== 0 ? (delta / Math.abs(oldV)) * 100 : 0;
          resized.push({ key: p.key, symbol: p.symbol, side: p.side, oldV, newV, delta, rel });
        }
      }
    }

    const now = Date.now();
    const heartbeatDue = !prev.lastHeartbeat ||
      (now - prev.lastHeartbeat) >= HEARTBEAT_HOURS * 3600 * 1000;

    const parts = [`HyperDash монитор\n${TRADER_URL}`];

    if (heartbeatDue) {
      const lines = curr
        .map(p => `• ${p.symbol} ${p.side} — ${fmt(p.sizeCoin)} ${p.symbol}`)
        .join("\n");
      parts.push(`⏰ Плановый отчёт (каждые ${HEARTBEAT_HOURS}ч)\nТекущие позиции (${curr.length}):\n${lines || "—"}`);
    }

    if (added.length) {
      const byKey = Object.fromEntries(curr.map(p => [p.key, p]));
      parts.push(
        "Открыты позиции:\n" +
        added.map(k => {
          const p = byKey[k];
          return p
            ? `• ${p.symbol} ${p.side} — ${fmt(p.sizeCoin)} ${p.symbol}`
            : `• ${k.replace(":", " ")}`;
        }).join("\n")
      );
    }

    if (removed.length) {
      parts.push(
        "Закрыты позиции:\n" +
        removed.map(k => {
          const lastSz = prev.sizes?.[k];
          const [sym, side] = k.split(":");
          return lastSz != null
            ? `• ${sym} ${side} — было ${fmt(lastSz)} ${sym}`
            : `• ${sym} ${side}`;
        }).join("\n")
      );
    }

    if (resized.length) {
      parts.push(
        "Изменение размера (в монетах):\n" +
        resized.map(r =>
          `• ${r.symbol} ${r.side}: ${fmt(r.oldV)} → ${fmt(r.newV)} ${r.symbol} ` +
          `(${r.delta > 0 ? "+" : ""}${fmt(r.delta)}; ${r.delta > 0 ? "+" : ""}${fmt(r.rel, 2)}%)`
        ).join("\n")
      );
    }

    const shouldSend =
      heartbeatDue || added.length || removed.length || resized.length;

    if (shouldSend) {
      await sendTelegram(parts.join("\n\n"));
    } else {
      console.log("No changes.");
    }

    const sizes = { ...(prev.sizes || {}) };
    for (const p of curr) if (p.sizeCoin != null) sizes[p.key] = p.sizeCoin;

    const nextState = { keys, sizes, lastHeartbeat: prev.lastHeartbeat || 0 };
    if (heartbeatDue) nextState.lastHeartbeat = now;
    saveState(nextState);
  } catch (e) {
    console.error("Error:", e);
    try { await sendTelegram(`⚠️ Ошибка монитора: ${e.message}`); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

