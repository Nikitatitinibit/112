// check-once.js — монитор Hyperdash → Telegram
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const TRADER_URL =
  process.env.TRADER_URL ||
  "https://hyperdash.info/trader/0x9eec98d048d06d9cd75318fffa3f3960e081daab";

const STATE_FILE = path.join(process.cwd(), "state-keys.json");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SIZE_TOL = Number(process.env.SIZE_TOL || 0);          // абсолютный порог
const SIZE_TOL_REL = Number(process.env.SIZE_TOL_REL || 0.005); // 0.5%
const HEARTBEAT_HOURS = Number(process.env.HEARTBEAT_HOURS || 24);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("No TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in env");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("Telegram send error:", e);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { keys: {}, lastHeartbeat: 0 };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function fmtNum(n, digits = 2) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });
}

const keyOf = (p) => `${p.asset} ${p.side}`;

// ждём именно таблицу позиций (с повторами)
async function waitPositionsTable(page) {
  await page.goto(TRADER_URL, { waitUntil: "networkidle2", timeout: 120000 });
  // “раскачиваем” страницу, чтобы ленивые блоки дорисовались
  await sleep(1500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1500);
  await page.evaluate(() => window.scrollTo(0, 0));

  // выбираем Perpetual, если есть
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, div, a, span"));
    const perp = btns.find((b) => /perpetual/i.test(b.textContent || ""));
    if (perp) perp.click();
  });

  // до 3 попыток ожидаем таблицу
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForFunction(
        () => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
          const tables = Array.from(document.querySelectorAll("table"));
          return tables.some((t) => {
            const headers = Array.from(t.querySelectorAll("th")).map((th) =>
              norm(th.innerText)
            );
            return (
              headers.includes("asset") &&
              headers.some((h) => h.includes("position value"))
            );
          });
        },
        { timeout: 90000 } // 90s
      );
      return; // нашли — выходим
    } catch (e) {
      if (i === 2) throw e;
      await page.reload({ waitUntil: "networkidle2", timeout: 120000 });
    }
  }
}

// парсим строки таблицы → [{asset, side, size, sizeStr}]
async function grabPositions(page) {
  const rows = await page.evaluate(() => {
    function norm(s) {
      return (s || "").replace(/\s+/g, " ").trim();
    }
    const tables = Array.from(document.querySelectorAll("table"));
    const table = tables.find((t) => {
      const headers = Array.from(t.querySelectorAll("th")).map((th) =>
        norm(th.innerText).toLowerCase()
      );
      return (
        headers.includes("asset") &&
        headers.some((h) => h.includes("position value"))
      );
    });
    if (!table) return [];

    const trs = Array.from(table.querySelectorAll("tbody tr"));
    return trs
      .map((tr) => {
        const tds = Array.from(tr.querySelectorAll("td"));
        const rowText = norm(tr.innerText);

        // Asset — первый TD: "ETH\n10x" → берём первую строку
        let assetCell = norm(tds[0]?.innerText || "");
        let asset = assetCell.split(/\n/)[0].trim();

        // Side
        const side = /short/i.test(rowText) ? "SHORT" : "LONG";

        // Размер в монетах: "61,000.84 ETH", "44,317,789 XRP", …
        let sizeStr = "";
        let size = 0;
        const re = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*${asset}\\b`, "i");
        const m = rowText.match(re);
        if (m) {
          sizeStr = `${m[1]} ${asset}`;
          size = Number(m[1].replace(/,/g, ""));
        } else {
          // fallback: любая пара "число + ТИКЕР"
          const m2 = rowText.match(/([\d,]+(?:\.\d+)?)\s*([A-Z]{2,})\b/);
          if (m2) {
            sizeStr = `${m2[1]} ${m2[2]}`;
            size = Number(m2[1].replace(/,/g, ""));
            asset = m2[2];
          }
        }

        return { asset, side, size, sizeStr };
      })
      .filter((p) => p.asset && p.size > 0);
  });

  const uniq = new Map();
  for (const p of rows) uniq.set(keyOf(p), p);
  return [...uniq.values()];
}

function diffPositions(prevKeys, cur) {
  const prev = new Set(Object.keys(prevKeys || {}));
  const curKeys = new Set(cur.map((p) => keyOf(p)));

  const added = [...curKeys].filter((k) => !prev.has(k));
  const removed = [...prev].filter((k) => !curKeys.has(k));

  const sizeChanged = [];
  for (const p of cur) {
    const k = keyOf(p);
    if (prev.has(k)) {
      const prevSize = prevKeys[k]?.size || 0;
      const abs = Math.abs(p.size - prevSize);
      const rel = prevSize > 0 ? abs / prevSize : 1;
      if (abs > SIZE_TOL && rel > SIZE_TOL_REL) {
        sizeChanged.push({ k, prevSize, curSize: p.size, p });
      }
    }
  }
  return { added, removed, sizeChanged };
}

function renderList(title, arr) {
  if (!arr.length) return "";
  return `${title}\n` + arr.map((s) => `• ${s}`).join("\n");
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--no-zygote",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
    );
    await page.setViewport({ width: 1366, height: 900 });

    await waitPositionsTable(page);

    const curPositions = await grabPositions(page); // [{asset, side, size, sizeStr}]
    const state = loadState(); // {keys, lastHeartbeat}
    const prevKeys = state.keys || {};

    const { added, removed, sizeChanged } = diffPositions(prevKeys, curPositions);

    const blocks = [];

    if (added.length) {
      const lines = added.map((k) => {
        const p = curPositions.find((x) => keyOf(x) === k);
        return `${p.asset} ${p.side} — ${p.sizeStr}`;
      });
      blocks.push(renderList("*Открыты позиции*:", lines));
    }

    if (removed.length) {
      const lines = removed.map((k) => {
        const prev = prevKeys[k];
        const [asset, side] = k.split(" ");
        const wasStr = prev?.size ? `${fmtNum(prev.size)} ${asset}` : `${asset}`;
        return `${asset} ${side} — было ${wasStr}`;
      });
      blocks.push(renderList("*Закрыты позиции*:", lines));
    }

    if (sizeChanged.length) {
      const lines = sizeChanged.map(({ p, prevSize, curSize }) => {
        const a = p.asset;
        return `${a} ${p.side} — было ${fmtNum(prevSize)} ${a}, стало ${fmtNum(
          curSize
        )} ${a}`;
      });
      blocks.push(renderList("*Изменение размера позиций*:", lines));
    }

    if (blocks.length) {
      await sendTelegram(
        `HyperDash монитор\n${TRADER_URL}\n\n${blocks.join("\n\n")}`
      );
    }

    const now = Date.now();
    const needHeartbeat =
      !state.lastHeartbeat ||
      now - state.lastHeartbeat > HEARTBEAT_HOURS * 3600 * 1000;

    if (needHeartbeat) {
      const lines = curPositions.map(
        (p) => `• ${p.asset} ${p.side} — ${p.sizeStr}`
      );
      const report = lines.length ? lines.join("\n") : "—";
      await sendTelegram(
        `HyperDash монитор\n${TRADER_URL}\n\n⏰ Плановый отчёт (каждые ${HEARTBEAT_HOURS}ч)\nТекущие позиции (${curPositions.length}):\n${report}`
      );
      state.lastHeartbeat = now;
    }

    const nextKeys = {};
    for (const p of curPositions) nextKeys[keyOf(p)] = { size: p.size };
    state.keys = nextKeys;
    saveState(state);
  } catch (e) {
    console.error("Error:", e);
    // создаём state, чтобы следующий прогон не ломался
    try {
      const prev = loadState();
      saveState({ keys: prev.keys || {}, lastHeartbeat: prev.lastHeartbeat || 0 });
    } catch {}
    // сигнализируем Actions о сбое
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
