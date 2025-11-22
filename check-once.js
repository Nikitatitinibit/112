// монитор Hyperdash → Telegram (устойчивое ожидание таблицы + размер в монетах)

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const TRADER_URL = process.env.TRADER_URL || "https://hyperdash.info/trader/0x9eec98d048d06d9cd75318fffa3f3960e081daab";
const STATE_FILE = path.join(process.cwd(), "state-keys.json");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SIZE_TOL = Number(process.env.SIZE_TOL || 0);
const SIZE_TOL_REL = Number(process.env.SIZE_TOL_REL || 0.005); // 0.5%
const HEARTBEAT_HOURS = Number(process.env.HEARTBEAT_HOURS || 24);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("No TELEGRAM_TOKEN or TELEGRAM_CHAT_ID");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .catch(e => console.error("Telegram send error:", e));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { keys: {}, lastHeartbeat: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
const fmtNum = (n, d = 2) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
const keyOf = (p) => `${p.asset} ${p.side}`;

// клик по элементу по тексту (без исключений)
async function clickByText(page, rx) {
  await page.evaluate((reStr) => {
    const re = new RegExp(reStr, "i");
    const els = Array.from(document.querySelectorAll("button, a, div, span"));
    const el = els.find(e => re.test(e.textContent || ""));
    if (el) el.click();
  }, rx.source);
}

// ждём появления таблицы с заголовками Asset / Position Value / Size и хотя бы одной строкой
async function waitPositionsTable(page, totalMs = 60000) {
  const start = Date.now();

  // начальная загрузка
  await page.goto(TRADER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  // чуть подождать рендера
  await sleep(1200);

  // серия попыток: скролл → клик Perpetual → клик Asset Positions → проверка таблицы
  while (Date.now() - start < totalMs) {
    // «пошевелить» страницу
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(600);
    await page.evaluate(() => window.scrollTo(0, 0));

    // попытки включить нужные табы/пилюли
    await clickByText(page, /perpetual/);
    await clickByText(page, /asset positions|positions/i);

    // есть ли таблица с нужными заголовками и строками?
    const hasRows = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const tables = Array.from(document.querySelectorAll("table"));
      for (const t of tables) {
        const headers = Array.from(t.querySelectorAll("th")).map(th => norm(th.innerText));
        const ok = headers.includes("asset") && headers.some(h => h.includes("position value"));
        if (ok) {
          const rows = t.querySelectorAll("tbody tr");
          if (rows && rows.length > 0) return true;
        }
      }
      return false;
    });

    if (hasRows) return true;
    await sleep(800);
  }
  return false;
}

// сбор позиций из таблицы
async function grabPositions(page) {
  const rows = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    function pickTable() {
      const tables = Array.from(document.querySelectorAll("table"));
      return tables.find(t => {
        const headers = Array.from(t.querySelectorAll("th")).map(th => norm(th.innerText).toLowerCase());
        return headers.includes("asset") && headers.some(h => h.includes("position value"));
      });
    }

    const table = pickTable();
    if (!table) return [];

    const trs = Array.from(table.querySelectorAll("tbody tr"));
    const parsed = [];

    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll("td"));
      const rowText = norm(tr.innerText);

      let assetCell = norm(tds[0]?.innerText || "");
      let asset = assetCell.split(/\n/)[0].trim() || assetCell.trim();
      if (!asset) continue;

      const side = /short/i.test(rowText) ? "SHORT" : "LONG";

      // ищем «число + ТИКЕР»
      const re = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*${asset}\\b`, "i");
      let m = rowText.match(re);
      let size = 0, sizeStr = "";

      if (m) {
        size = Number(m[1].replace(/,/g, ""));
        sizeStr = `${m[1]} ${asset}`;
      } else {
        const m2 = rowText.match(/([\d,]+(?:\.\d+)?)\s*([A-Z]{2,})\b/);
        if (m2) {
          size = Number(m2[1].replace(/,/g, ""));
          asset = m2[2];
          sizeStr = `${m2[1]} ${asset}`;
        }
      }

      if (asset && size > 0) parsed.push({ asset, side, size, sizeStr });
    }

    // уникализируем по «ASSET SIDE»
    const map = new Map();
    for (const p of parsed) map.set(`${p.asset} ${p.side}`, p);
    return [...map.values()];
  });

  return rows;
}

function diffPositions(prevKeys, cur) {
  const prev = new Set(Object.keys(prevKeys || {}));
  const curKeys = new Set(cur.map(p => keyOf(p)));

  const added = [...curKeys].filter(k => !prev.has(k));
  const removed = [...prev].filter(k => !curKeys.has(k));

  const sizeChanged = [];
  for (const p of cur) {
    const k = keyOf(p);
    if (prev.has(k)) {
      const prevSize = prevKeys[k]?.size || 0;
      const abs = Math.abs(p.size - prevSize);
      const rel = prevSize > 0 ? abs / prevSize : 1;
      if (abs > SIZE_TOL && rel > SIZE_TOL_REL) sizeChanged.push({ p, prevSize, curSize: p.size });
    }
  }
  return { added, removed, sizeChanged };
}

const renderList = (title, arr) => arr.length ? `${title}\n` + arr.map(s => `• ${s}`).join("\n") : "";

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process", "--no-zygote"],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(45000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari");
    await page.setViewport({ width: 1366, height: 900 });

    // ждём таблицу; если не вышло — один перезагрузочный шанс
    let ok = await waitPositionsTable(page, 60000);
    if (!ok) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1500);
      ok = await waitPositionsTable(page, 30000);
    }
    if (!ok) {
      await sendTelegram(`HyperDash монитор\n${TRADER_URL}\n\nНе удалось дождаться таблицы позиций за отведённое время.`);
      return;
    }

    const curPositions = await grabPositions(page); // [{asset, side, size, sizeStr}]
    const state = loadState();                       // {keys, lastHeartbeat}
    const prevKeys = state.keys || {};

    const { added, removed, sizeChanged } = diffPositions(prevKeys, curPositions);

    const blocks = [];

    if (added.length) {
      const lines = added.map(k => {
        const p = curPositions.find(x => keyOf(x) === k);
        return `${p.asset} ${p.side} — ${p.sizeStr}`;
      });
      blocks.push(renderList("*Открыты позиции*:", lines));
    }

    if (removed.length) {
      const lines = removed.map(k => {
        const p = prevKeys[k];
        const [asset, side] = k.split(" ");
        const wasStr = p?.size ? `${fmtNum(p.size)} ${asset}` : asset;
        return `${asset} ${side} — было ${wasStr}`;
      });
      blocks.push(renderList("*Закрыты позиции*:", lines));
    }

    if (sizeChanged.length) {
      const lines = sizeChanged.map(({ p, prevSize, curSize }) =>
        `${p.asset} ${p.side} — было ${fmtNum(prevSize)} ${p.asset}, стало ${fmtNum(curSize)} ${p.asset}`
      );
      blocks.push(renderList("*Изменение размера позиций*:", lines));
    }

    if (blocks.length) {
      await sendTelegram(`HyperDash монитор\n${TRADER_URL}\n\n${blocks.join("\n\n")}`);
    }

    // heartbeat раз в N часов
    const now = Date.now();
    const needHeartbeat = !state.lastHeartbeat || now - state.lastHeartbeat > HEARTBEAT_HOURS * 3600 * 1000;
    if (needHeartbeat) {
      const lines = curPositions.map(p => `• ${p.asset} ${p.side} — ${p.sizeStr}`);
      await sendTelegram(`HyperDash монитор\n${TRADER_URL}\n\n⏰ Плановый отчёт (каждые ${HEARTBEAT_HOURS}ч)\nТекущие позиции (${curPositions.length}):\n${lines.length ? lines.join("\n") : "—"}`);
      state.lastHeartbeat = now;
    }

    // сохраняем «ключ → размер»
    const nextKeys = {};
    for (const p of curPositions) nextKeys[keyOf(p)] = { size: p.size };
    state.keys = nextKeys;
    saveState(state);

  } catch (e) {
    console.error(e);
    await sendTelegram(`HyperDash монитор\n${TRADER_URL}\n\nОшибка выполнения: ${String(e).slice(0, 1500)}`);
  } finally {
    await browser.close();
  }
})();
