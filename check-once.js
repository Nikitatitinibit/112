// check-once.js — монитор Hyperdash → Telegram (устойчивое ожидание зоны позиций + двойной парсер)

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const TRADER_URL =
  process.env.TRADER_URL ||
  "https://hyperdash.info/trader/0x9eec98d048d06d9cd75318fffa3f3960e081daab";
const STATE_FILE = path.join(process.cwd(), "state-keys.json");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// чувствительность размера (абсолют/доля)
const SIZE_TOL = Number(process.env.SIZE_TOL || 0);
const SIZE_TOL_REL = Number(process.env.SIZE_TOL_REL || 0.005); // 0.5%
const HEARTBEAT_HOURS = Number(process.env.HEARTBEAT_HOURS || 24);

// утилиты
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtNum = (n, digits = 2) =>
  Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });
const keyOf = (p) => `${p.asset} ${p.side}`;

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("No TELEGRAM_TOKEN or TELEGRAM_CHAT_ID");
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

/** Ждём ЗОНУ позиций, а не конкретную <table> */
async function waitPositionsArea(page) {
  console.log("⏳ Открываю страницу…");
  await page.goto(TRADER_URL, { waitUntil: "networkidle2", timeout: 120000 });

  // «пнуть» рендер
  await sleep(1200);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(800);
  await page.evaluate(() => window.scrollTo(0, 0));

  // клик «Perpetual», если он есть
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, div, a, span"));
    const perp = btns.find((b) => /perpetual/i.test(b.textContent || ""));
    if (perp) perp.click();
  });

  console.log("⏳ Жду зону позиций…");
  await page.waitForFunction(() => {
    const text = (document.body.innerText || "").toLowerCase();
    const hasTabs =
      /asset positions/i.test(document.body.innerText || "") ||
      /open orders/i.test(document.body.innerText || "");
    const hasColumns =
      text.includes("position value") ||
      text.includes("unrealized pnl") ||
      text.includes("entry price");
    const hasRows =
      document.querySelector("tbody tr") || document.querySelector('[role="row"]');
    return hasTabs || (hasColumns && hasRows);
  }, { timeout: 60000 });
}

/** Парсер А: «табличный» */
async function parseAsTable(page) {
  return await page.evaluate(() => {
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
    const rows = trs.map((tr) => {
      const rowText = norm(tr.innerText);
      const tds = Array.from(tr.querySelectorAll("td"));
      let assetCell = norm(tds[0]?.innerText || "");
      let asset = assetCell.split(/\n/)[0].trim();
      const side = /short/i.test(rowText) ? "SHORT" : "LONG";

      let sizeStr = "";
      let size = 0;
      const re = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*${asset}\\b`, "i");
      const m = rowText.match(re);
      if (m) {
        sizeStr = `${m[1]} ${asset}`;
        size = Number(m[1].replace(/,/g, ""));
      } else {
        const m2 = rowText.match(/([\d,]+(?:\.\d+)?)\s*([A-Z]{2,})\b/);
        if (m2) {
          sizeStr = `${m2[1]} ${m2[2]}`;
          size = Number(m2[1].replace(/,/g, ""));
          asset = m2[2];
        }
      }
      return { asset, side, size, sizeStr };
    });

    // uniq по ключу
    const map = new Map();
    for (const r of rows) {
      if (r.asset && r.size > 0) map.set(`${r.asset} ${r.side}`, r);
    }
    return [...map.values()];
  });
}

/** Парсер B: текстовый резерв (работает и на div-гридах) */
async function parseAsText(page) {
  return await page.evaluate(() => {
    function uniqByKey(arr, key) {
      const m = new Map();
      for (const x of arr) m.set(key(x), x);
      return [...m.values()];
    }
    const text = document.body.innerText || "";
    const re =
      /\b([A-Z]{2,5})\b[\s\S]{0,80}?\b(LONG|SHORT)\b[\s\S]{0,280}?([\d,]+(?:\.\d+)?)\s*\1\b/g;
    const found = [];
    let m;
    while ((m = re.exec(text))) {
      const asset = m[1];
      const side = m[2].toUpperCase();
      const size = Number(m[3].replace(/,/g, ""));
      const sizeStr = `${m[3]} ${asset}`;
      if (asset && size > 0) found.push({ asset, side, size, sizeStr });
    }
    return uniqByKey(found, (x) => `${x.asset} ${x.side}`);
  });
}

/** Снимаем позиции: сначала «таблица», если пусто — «текст» */
async function grabPositions(page) {
  const table = await parseAsTable(page);
  if (table.length) return table;
  const text = await parseAsText(page);
  return text;
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
      if (abs > SIZE_TOL && rel > SIZE_TOL_REL)
        sizeChanged.push({ k, prevSize, curSize: p.size, p });
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

    await waitPositionsArea(page);

    const curPositions = await grabPositions(page);
    console.log(`✅ Снято позиций: ${curPositions.length}`);

    const state = loadState();
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
      const lines = sizeChanged.map(
        ({ p, prevSize, curSize }) =>
          `${p.asset} ${p.side} — было ${fmtNum(prevSize)} ${p.asset}, стало ${fmtNum(
            curSize
          )} ${p.asset}`
      );
      blocks.push(renderList("*Изменение размера позиций*:", lines));
    }

    if (blocks.length) {
      await sendTelegram(`HyperDash монитор\n${TRADER_URL}\n\n${blocks.join("\n\n")}`);
    }

    // Heartbeat
    const now = Date.now();
    const needHeartbeat =
      !state.lastHeartbeat || now - state.lastHeartbeat > HEARTBEAT_HOURS * 3600 * 1000;
    if (needHeartbeat) {
      const lines = curPositions.map((p) => `• ${p.asset} ${p.side} — ${p.sizeStr}`);
      const report = lines.length ? lines.join("\n") : "—";
      await sendTelegram(
        `HyperDash монитор\n${TRADER_URL}\n\n⏰ Плановый отчёт (каждые ${HEARTBEAT_HOURS}ч)\nТекущие позиции (${curPositions.length}):\n${report}`
      );
      state.lastHeartbeat = now;
    }

    // сохранить состояние
    const nextKeys = {};
    for (const p of curPositions) nextKeys[keyOf(p)] = { size: p.size };
    state.keys = nextKeys;
    saveState(state);
  } catch (e) {
    console.error("❌ Error:", e);
    await sendTelegram(
      `⚠️ HyperDash монитор: ошибка выполнения\n${TRADER_URL}\n\n\`${String(e)}\``
    );
    process.exitCode = 1; // пусть job становится «красным», чтобы ошибка не терялась
  } finally {
    await browser.close();
  }
})();

