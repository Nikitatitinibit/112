// check-once.js
// Алерты в Telegram при открытии/закрытии и ИЗМЕНЕНИИ РАЗМЕРА В МОНЕТАХ.

const fs = require("fs").promises;
const puppeteer = require("puppeteer");

const TRADER_URL = process.env.TRADER_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const STATE_FILE = process.env.STATE_FILE || "last_positions.json";

// Пороги: абсолютный в монетах и/или относительный (долевая часть)
const SIZE_TOL = parseFloat(process.env.SIZE_TOL || "0");          // напр. 0.01
const SIZE_TOL_REL = parseFloat(process.env.SIZE_TOL_REL || "0");  // напр. 0.005 (0.5%)

function fmt(n) {
  if (!isFinite(n)) return String(n);
  const a = Math.abs(n);
  if (a >= 1e6) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a >= 1)   return n.toFixed(4);
  return n.toPrecision(6);
}

async function tgSend(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[log] Telegram not configured. Message:\n" + text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: "true"
  });
  const res = await fetch(url, { method: "POST", body });
  if (!res.ok) {
    console.error("Telegram error:", res.status, await res.text());
  }
}

async function loadState() {
  try {
    const t = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(t);
  } catch {
    return { index: {} };
  }
}
async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// --- рекурсивный обход JSON ---
function* walk(obj) {
  if (Array.isArray(obj)) {
    for (const v of obj) yield* walk(v);
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      yield [k, v];
      yield* walk(v);
    }
  }
}

// извлекаем сторону
function pickSide(p) {
  if (p.side) return String(p.side).toLowerCase();
  if (typeof p.isLong === "boolean") return p.isLong ? "long" : "short";
  if (typeof p.long === "boolean") return p.long ? "long" : "short";
  if (p.positionSide) return String(p.positionSide).toLowerCase();
  return "unknown";
}

// ГЛАВНОЕ: выбираем РАЗМЕР В МОНЕТАХ
function pickCoinSize(p) {
  // приоритет полей «в монетах»/контрактах
  const keysPriority = [
    "szi", "sz", "positionSize", "baseSize", "qty", "contracts", "contractSize", "coinSize"
  ];
  for (const k of keysPriority) {
    if (p[k] != null && isFinite(Number(p[k]))) {
      return Math.abs(Number(p[k]));
    }
  }
  // Если вдруг есть поле 'size', попробуем взять его только если рядом НЕТ явной USD-стоимости
  // (то есть с меньшей вероятностью, что это notional в $)
  if (p.size != null && isFinite(Number(p.size))) {
    const usdHints = ["usd", "notional", "value"];
    const hasUsd = Object.keys(p).some(x => usdHints.some(h => x.toLowerCase().includes(h)));
    if (!hasUsd) return Math.abs(Number(p.size));
  }
  return null;
}

function normalize(list) {
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const symbol = p.symbol || p.coin || p.asset || p.token || p.name;
    const side = pickSide(p);
    const coinSize = pickCoinSize(p);
    if (!symbol || coinSize == null || coinSize === 0) continue;
    out.push({ symbol: String(symbol), side, sizeCoin: coinSize });
  }
  return out;
}

function extractPositionsFromNext(json) {
  const candidates = [];
  for (const [k, v] of walk(json)) {
    if (k === "positions" && Array.isArray(v)) candidates.push(v);
    if (Array.isArray(v) && v.length && v.every(x => typeof x === "object")) {
      candidates.push(v);
    }
  }
  for (const c of candidates) {
    const n = normalize(c);
    if (n.length) return n;
  }
  return [];
}

function toIndex(positions) {
  const idx = {};
  for (const p of positions) idx[`${p.symbol}:${p.side}`] = p.sizeCoin;
  return idx;
}

function changedEnough(oldV, newV) {
  const absDelta = Math.abs(newV - oldV);
  const relDelta = oldV !== 0 ? absDelta / Math.abs(oldV) : Infinity;
  if (SIZE_TOL > 0 && absDelta > SIZE_TOL) return true;
  if (SIZE_TOL_REL > 0 && relDelta > SIZE_TOL_REL) return true;
  // если пороги не заданы — любое изменение
  if (SIZE_TOL === 0 && SIZE_TOL_REL === 0 && absDelta > 0) return true;
  return false;
}

function diff(prevIdx, currIdx) {
  const opened = [];
  const closed = [];
  const resized = [];

  for (const k of Object.keys(currIdx)) {
    if (!(k in prevIdx)) {
      opened.push([k, currIdx[k]]);
    } else if (changedEnough(prevIdx[k], currIdx[k])) {
      resized.push([k, prevIdx[k], currIdx[k]]);
    }
  }
  for (const k of Object.keys(prevIdx)) {
    if (!(k in currIdx)) closed.push([k, prevIdx[k]]);
  }
  return { opened, closed, resized };
}

async function fetchPositions() {
  if (!TRADER_URL) throw new Error("TRADER_URL env is not set");

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  try {
    const page = await browser.newPage();
    await page.goto(TRADER_URL, { waitUntil: "networkidle2", timeout: 120000 });

    const nextData = await page.evaluate(() => {
      const el = document.querySelector("#__NEXT_DATA__");
      return el ? el.textContent : null;
    });
    if (!nextData) return [];

    const json = JSON.parse(nextData);
    return extractPositionsFromNext(json);
  } finally {
    await browser.close();
  }
}

async function main() {
  const prevState = await loadState();
  const prevIdx = prevState.index || {};

  const positions = await fetchPositions();
  const currIdx = toIndex(positions);

  const { opened, closed, resized } = diff(prevIdx, currIdx);
  if (!opened.length && !closed.length && !resized.length) {
    console.log("No changes.");
    return;
  }

  const parts = [`🔔 HyperDash мониторинг (coin size)\n${TRADER_URL}`];
  if (opened.length) {
    parts.push("🟢 ОТКРЫТО:");
    for (const [k, v] of opened) {
      const [sym, side] = k.split(":");
      parts.push(`• ${sym} ${side} — ${fmt(v)} ${sym}`);
    }
  }
  if (closed.length) {
    parts.push("🔴 ЗАКРЫТО:");
    for (const [k, v] of closed) {
      const [sym, side] = k.split(":");
      parts.push(`• ${sym} ${side} — было ${fmt(v)} ${sym}`);
    }
  }
  if (resized.length) {
    parts.push("🟨 ИЗМЕНЕНО (по монетам):");
    for (const [k, oldV, newV] of resized) {
      const [sym, side] = k.split(":");
      const d = newV - oldV;
      const sign = d > 0 ? "+" : "";
      parts.push(`• ${sym} ${side}: ${fmt(oldV)} → ${fmt(newV)} ${sym} (${sign}${fmt(d)})`);
    }
  }

  await tgSend(parts.join("\n"));
  await saveState({ index: currIdx, fetched_at: Math.floor(Date.now() / 1000) });
}

main().catch(async (e) => {
  console.error("Fatal:", e);
  try { await tgSend(`⚠️ Monitor error: ${e.message}`); } catch {}
  process.exit(1);
});
