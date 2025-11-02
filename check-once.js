// HyperDash -> Telegram
// Алерты: позиции (в монетах), Open Orders, плановый отчёт.

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
    if (!res.ok) throw new Error(`Telegram ${res.status}: ${txt}`);
  }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { keys: [], sizes: {}, ordersKeys: [], lastHeartbeat: 0 }; }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function uniq(a){ return [...new Set(a)]; }
function diffSets(prevArr, curArr){
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

// ── Снятие данных со страницы
async function getData(browser){
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  );
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(TRADER_URL, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(2500);

  // --- Positions (вкладка по умолчанию видна)
  const positions = await page.evaluate(() => {
    const NBSP_ALL = /[\u00A0\u202F\u2000-\u200B]/g;
    const clean = (s) => (s || "").replace(NBSP_ALL, " ");
    const trim = (s) => clean(s).replace(/\s+/g, " ").trim();
    const isVisible = (el) =>
      !!(el &&
         el.offsetParent !== null &&
         getComputedStyle(el).visibility !== "hidden" &&
         getComputedStyle(el).display !== "none");

    // контейнер таблицы позиций (работаем даже если текста нет)
    const containers = Array.from(document.querySelectorAll("section,div"));
    const posRoot =
      containers.find(el => /asset positions/i.test(el.innerText || "")) ||
      document.body;

    const rows = Array.from(posRoot.querySelectorAll("tr,[role='row']"))
      .filter(r => isVisible(r) && r.querySelectorAll("td,[role='cell']").length >= 3);

    const out = [];
    for (const row of rows) {
      const cells = row.querySelectorAll("td,[role='cell']");
      const t0 = trim(cells[0].innerText).toUpperCase();
      const symbol = (t0.split(/\s+/)[0] || "").replace(/[^A-Z0-9.\-:]/g,"");
      if (!symbol || symbol === "ASSET") continue;

      const t1 = trim(cells[1].innerText).toUpperCase();
      const side = (t1.match(/\b(LONG|SHORT)\b/) || [,""])[1];
      if (!side) continue;

      const raw2 = clean(cells[2].innerText || "");
      const lines = raw2.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      let sizeLine = lines.find(s => s.toUpperCase().includes(symbol) && !s.includes("$"));
      if (!sizeLine) {
        const parts = raw2.split(/ {2,}/).map(s => s.trim()).filter(Boolean);
        sizeLine = parts.find(s => s.toUpperCase().includes(symbol) && !s.includes("$")) || "";
      }
      let sizeCoin = null;
      const m = /([0-9][0-9.,\s\u00A0\u202F\u2000-\u200B]+)/.exec(sizeLine);
      if (m) {
        const val = Number(String(m[1]).replace(/[\s,\u00A0\u202F\u2000-\u200B]/g, ""));
        if (Number.isFinite(val)) sizeCoin = val;
      }
      out.push({ key: `${symbol}:${side}`, symbol, side, sizeCoin });
    }
    return out;
  });

  // --- Кликаем вкладку "Open Orders"
  await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("a,button,div,span"));
    const btn = all.find(el => /open\s*orders/i.test((el.textContent || "").replace(/\s+/g," ").trim()));
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(700); // даём дорисоваться

  // --- Orders (парсим только видимые строки)
  const orders = await page.evaluate(() => {
    const NBSP_ALL = /[\u00A0\u202F\u2000-\u200B]/g;
    const clean = (s) => (s || "").replace(NBSP_ALL, " ");
    const trim = (s) => clean(s).replace(/\s+/g, " ").trim();
    const isVisible = (el) =>
      !!(el &&
         el.offsetParent !== null &&
         getComputedStyle(el).visibility !== "hidden" &&
         getComputedStyle(el).display !== "none");

    const rows = Array.from(document.querySelectorAll("tr,[role='row']"))
      .filter(r => isVisible(r) && r.querySelectorAll("td,[role='cell']").length >= 3);

    const out = [];
    for (const row of rows) {
      const cells = row.querySelectorAll("td,[role='cell']");
      if (cells.length < 3) continue;

      // символ из 1-й ячейки
      let symbol = trim(cells[0].innerText).toUpperCase().split(/\s+/)[0].replace(/[^A-Z0-9.\-:]/g,"");
      if (!symbol || symbol === "ASSET") continue;

      // сторона из текста строки
      const rowText = trim(row.innerText).toUpperCase();
      const side = (rowText.match(/\b(BUY|SELL|LONG|SHORT)\b/) || [,""])[1];
      if (!side) continue;

      // размер "<число> SYMBOL"
      let sizeCoin = null;
      for (const c of cells) {
        const tx = clean(c.innerText || "").toUpperCase();
        const mm = new RegExp("([0-9][0-9.,\\s\\u00A0\\u202F\\u2000-\\u200B]+)\\s*" + symbol + "\\b").exec(tx);
        if (mm) {
          const v = Number(String(mm[1]).replace(/[\s,\u00A0\u202F\u2000-\u200B]/g,""));
          if (Number.isFinite(v)) { sizeCoin = v; break; }
        }
      }

      // цена — сначала ищем с "$", иначе просто число с точкой/дефолтной точностью
      let price = null;
      for (const c of cells) {
        const tx = clean(c.innerText || "");
        let mm = /\$\s*([0-9][0-9,]*\.?[0-9]+)/.exec(tx);
        if (!mm) mm = /(^|\s)([0-9][0-9,]*\.[0-9]{2,})($|\s)/.exec(tx);
        if (mm) {
          const raw = (mm[1] || mm[2]).replace(/,/g,"");
          const v = Number(raw);
          if (Number.isFinite(v)) { price = v; break; }
        }
      }

      if (sizeCoin == null || price == null) continue;
      const szN = Math.round(sizeCoin * 1e8) / 1e8;
      const prN = Math.round(price * 100) / 100;
      out.push({ key: `${symbol}:${side}:${szN}@${prN}`, symbol, side, size: szN, price: prN });
    }
    return out;
  });

  await page.close();
  return { positions, orders };
}

// ── Основной цикл
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
    const prev = loadState();
    const { positions: currPos, orders: currOrd } = await getData(browser);

    // позиции
    const posKeys = uniq(currPos.map(p => p.key)).sort();
    const { added: posAdded, removed: posRemoved } = diffSets(prev.keys, posKeys);

    const resized = [];
    for (const p of currPos) {
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

    // ордера
    const ordKeys = uniq(currOrd.map(o => o.key)).sort();
    const { added: ordAdded, removed: ordRemoved } = diffSets(prev.ordersKeys || [], ordKeys);

    const now = Date.now();
    const heartbeatDue = !prev.lastHeartbeat ||
      (now - prev.lastHeartbeat) >= HEARTBEAT_HOURS * 3600 * 1000;

    const parts = [`HyperDash монитор\n${TRADER_URL}`];

    if (heartbeatDue) {
      const posLines = currPos
        .map(p => `• ${p.symbol} ${p.side} — ${fmt(p.sizeCoin)} ${p.symbol}`)
        .join("\n");
      const ordLines = currOrd
        .map(o => `• ${o.symbol} ${o.side} — ${fmt(o.size,8)} ${o.symbol} @ $${fmt(o.price,2)}`)
        .join("\n");
      parts.push(
        `⏰ Плановый отчёт (каждые ${HEARTBEAT_HOURS}ч)\n` +
        `Текущие позиции (${currPos.length}):\n${posLines || "—"}\n\n` +
        `Открытые ордера (${currOrd.length}):\n${ordLines || "—"}`
      );
    }

    if (posAdded.length) {
      const byKey = Object.fromEntries(currPos.map(p => [p.key, p]));
      parts.push(
        "Открыты позиции:\n" +
        posAdded.map(k => {
          const p = byKey[k];
          return p
            ? `• ${p.symbol} ${p.side} — ${fmt(p.sizeCoin)} ${p.symbol}`
            : `• ${k.replace(":", " ")}`;
        }).join("\n")
      );
    }

    if (posRemoved.length) {
      parts.push(
        "Закрыты позиции:\n" +
        posRemoved.map(k => {
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
        "Изменение размера позиции (в монетах):\n" +
        resized.map(r =>
          `• ${r.symbol} ${r.side}: ${fmt(r.oldV)} → ${fmt(r.newV)} ${r.symbol} ` +
          `(${r.delta > 0 ? "+" : ""}${fmt(r.delta)}; ${r.delta > 0 ? "+" : ""}${fmt(r.rel, 2)}%)`
        ).join("\n")
      );
    }

    if (ordAdded.length) {
      const byKey = Object.fromEntries(currOrd.map(o => [o.key, o]));
      parts.push(
        "🟢 Новые ордера:\n" +
        ordAdded.map(k => {
          const o = byKey[k];
          return o
            ? `• ${o.symbol} ${o.side} — ${fmt(o.size,8)} ${o.symbol} @ $${fmt(o.price,2)}`
            : `• ${k}`;
        }).join("\n")
      );
    }

    if (ordRemoved.length) {
      parts.push(
        "⚪️ Ордер исполнен/снят:\n" +
        ordRemoved.map(k => {
          const m = /^([A-Z0-9.\-:]+):([A-Z]+):([0-9.]+)@([0-9.]+)$/.exec(k);
          if (m) {
            const [, sym, side, sz, pr] = m;
            return `• ${sym} ${side} — ${fmt(Number(sz),8)} ${sym} @ $${fmt(Number(pr),2)}`;
          }
          return `• ${k}`;
        }).join("\n")
      );
    }

    const shouldSend =
      heartbeatDue ||
      posAdded.length || posRemoved.length || resized.length ||
      ordAdded.length || ordRemoved.length;

    if (shouldSend) {
      await sendTelegram(parts.join("\n\n"));
    } else {
      console.log("No changes.");
    }

    const sizes = { ...(prev.sizes || {}) };
    for (const p of currPos) if (p.sizeCoin != null) sizes[p.key] = p.sizeCoin;

    const nextState = {
      keys: posKeys,
      sizes,
      ordersKeys: ordKeys,
      lastHeartbeat: heartbeatDue ? now : (prev.lastHeartbeat || 0),
    };
    saveState(nextState);
  } catch (e) {
    console.error("Error:", e);
    try { await sendTelegram(`⚠️ Ошибка монитора: ${e.message}`); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();


