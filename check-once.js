// HyperDash -> Telegram
// Алерты: открытие/закрытие, изменение размера (в монетах), плановый отчёт.

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
const fmt = (n, p = 2) =>
  n == null || !Number.isFinite(n)
    ? "-"
    : Math.abs(n) >= 1
    ? n.toLocaleString("en-US", { maximumFractionDigits: p })
    : n.toFixed(6);

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

// ── парсер позиций (робастный, двухпроходный по тексту раздела)
async function getPositions(browser){
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  );
  await page.setViewport({ width: 1366, height: 900 });
  await page.goto(TRADER_URL, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(2500);

  const items = await page.evaluate(() => {
    const NBSP_RX = /\u00A0|\u202F/g;
    const norm = (s) => (s || "").replace(NBSP_RX, " ").replace(/\s+/g, " ").trim();

    const roots = new Set();

    // пытаемся найти секцию с позициями
    document.querySelectorAll("*").forEach((el) => {
      const t = (el.textContent || "").toLowerCase();
      if (t.includes("asset positions") || t === "positions") {
        const r = el.closest("section") || el.parentElement || el;
        if (r) roots.add(r);
      }
    });
    roots.add(document.querySelector("[data-testid*='positions']"));
    roots.add(document.querySelector(".open-positions"));
    roots.add(document.querySelector("#positions"));

    // собираем «строки» из таблиц/рядов/листов, + все title
    const harvest = (root) => {
      if (!root) return [];
      const take = (el) => {
        const bucket = [];
        const push = (txt) => {
          const v = norm(txt);
          if (v) bucket.push(v);
        };
        push(el.innerText || "");
        el.querySelectorAll("[title]").forEach(n => push(n.getAttribute("title") || ""));
        return bucket.join(" | ");
      };

      const tbl = Array.from(root.querySelectorAll("tr"))
        .map(r => Array.from(r.querySelectorAll("th,td"))
          .map(take).filter(Boolean).join(" | "))
        .filter(Boolean);

      const grid = Array.from(root.querySelectorAll("[role='row']"))
        .map(take).filter(Boolean);

      const list = Array.from(root.querySelectorAll("li,.row"))
        .map(take).filter(Boolean);

      return [...new Set([...tbl, ...grid, ...list])];
    };

    const lines = [...new Set([...roots].filter(Boolean).flatMap(harvest))];

    // 1) sideMap: SYMBOL -> LONG/SHORT
    const sideMap = {};
    for (const raw of lines) {
      const s = raw.toUpperCase();
      const m = s.match(/\b([A-Z0-9.\-:]{2,15})\b.*\b(LONG|SHORT)\b/);
      if (m) {
        const sym = m[1];
        if (sym !== "ASSET" && sym !== "TYPE") sideMap[sym] = m[2];
      }
    }

    // 2) sizeMap: SYMBOL -> <число монет>, ищем по ЛЮБЫМ строкам (даже с $)
    const sizeMap = {};
    const RX = /([0-9][0-9.,\s\u00A0\u202F]+)\s*([A-Z0-9.\-:]{2,15})\b/g;

    for (const raw of lines) {
      const s = raw.toUpperCase();
      let m;
      while ((m = RX.exec(s))) {
        const val = Number(String(m[1]).replace(/[ \u00A0\u202F,]/g, ""));
        const sym = m[2];
        if (!Number.isFinite(val)) continue;
        if (sym === "ASSET" || sym === "TYPE" || sym === "PNL" || sym === "UPNL") continue;
        sizeMap[sym] = val; // последнее по документу значение — актуальный размер
      }
    }

    // 3) склейка
    const out = [];
    Object.entries(sideMap).forEach(([sym, side]) => {
      out.push({ key: `${sym}:${side}`, symbol: sym, side, sizeCoin: sizeMap[sym] ?? null });
    });

    return out;
  });

  await page.close();
  return items;
}

// ── основной запуск
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

