// check-once.js — монитор Hyperdash → Telegram (устойчивое ожидание таблицы + размер в монетах)

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const TRADER_URL =
  process.env.TRADER_URL ||
  "https://hyperdash.info/trader/0x9eec98d048d06d9cd75318fffa3f3960e081daab";
const STATE_FILE = path.join(process.cwd(), "state-keys.json");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// чувствительность: абсолютная и относительная (доли) — считаем изменением размера
const SIZE_TOL = Number(process.env.SIZE_TOL || 0); // абс. шаг
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

// ждём «что-то похожее на таблицу с позициями»: настоящая таблица, грид-строки, списки
async function waitPositionsArea(page, totalMs = 90000) {
  const start = Date.now();
  let round = 0;

  while (Date.now() - start < totalMs) {
    round++;
    // чуть подождать сети
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

    // лёгкий скролл туда-сюда, чтобы триггернуть ленивый рендер
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(700);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    // Переключить Perpetual (если кнопка есть)
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, a, div, span"))
        .find(n => /perpetual/i.test(n.textContent || ""));
      if (btn) btn.click();
    });

    // Открыть вкладку «Asset Positions» (или похожее)
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, a, div, span"))
        .find(n => /asset positions|positions/i.test(n.textContent || ""));
      if (btn) btn.click();
    });

    // Проверяем наличие хоть каких-то строк
    const found = await page.evaluate(() => {
      const q = (sel) => Array.from(document.querySelectorAll(sel));
      // таблица
      const hasTableRows = q("table tbody tr").length >= 1;
      // грид / div-строки
      const hasRoleRows = q('[role="row"]').length >= 2;
      // резерв: списки/карточки
      const hasGenericRows =
        q(".row").length >= 2 || q(".trade-row").length >= 2 || q("li").length >= 5;

      return hasTableRows || hasRoleRows || hasGenericRows;
    });

    if (found) return true;

    // ещё чуть подождать и попробовать снова
    await sleep(1500);
  }

  return false;
}

// вынимаем список позиций: [{asset, side, size, sizeStr}]
async function grabPositions(page) {
  const rows = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    function collectFromNodeList(list) {
      const out = [];
      for (const node of list) {
        const txt = norm(node.innerText || "");
        if (!txt) continue;

        // side
        const side = /short/i.test(txt) ? "SHORT" : "LONG";

        // попробовать взять asset из первой ячейки, если это таблица
        let asset = "";
        if (node.querySelectorAll) {
          const firstCellText = norm(node.querySelector("td, [role='cell']")?.innerText || "");
          if (firstCellText) asset = firstCellText.split(/\n/)[0].trim();
        }

        // если тикер не нашли — возьмём наиболее вероятный UPPERCASE-токен
        if (!asset) {
          const tick = txt.match(/\b[A-Z]{2,6}\b/g);
          // фильтруем слова типа LONG/SHORT/UPNL/PNL
          const ticker = (tick || []).find(t => !/LONG|SHORT|UPNL|PNL|MARGIN|PRICE|VALUE|SIZE/i.test(t));
          if (ticker) asset = ticker;
        }

        // размер: "<число> <тикер>"
        let size = 0;
        let sizeStr = "";
        if (asset) {
          const m = txt.match(new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*${asset}\\b`, "i"));
          if (m) {
            size = Number(m[1].replace(/,/g, ""));
            sizeStr = `${m[1]} ${asset}`;
          }
        }
        // fallback: первая пара «число + UPPER»
        if (!size) {
          const m2 = txt.match(/([\d,]+(?:\.\d+)?)\s*([A-Z]{2,6})\b/);
          if (m2) {
            size = Number(m2[1].replace(/,/g, ""));
            sizeStr = `${m2[1]} ${m2[2]}`;
            if (!asset) asset = m2[2];
          }
        }

        if (asset && size > 0) out.push({ asset, side, size, sizeStr });
      }
      return out;
    }

    // кандидаты: таблицы, грид-строки и generic-элементы
    const tables = Array.from(document.querySelectorAll("table tbody tr"));
    const roleRows = Array.from(document.querySelectorAll('[role="row"]')).slice(1); // пропустим заголовок
    const generic = Array.from(document.querySelectorAll(".row, .trade-row, li"));

    const all = [
      ...collectFromNodeList(tables),
      ...collectFromNodeList(roleRows),
      ...collectFromNodeList(generic),
    ];

    // уникализируем по "asset side"
    const uniq = new Map();
    for (const p of all) uniq.set(`${p.asset} ${p.side}`, p);
    return [...uniq.values()];
  });

  return rows;
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

    await page.goto(TRADER_URL, { waitUntil: "domcontentloaded", timeout: 120000 });

    const ok = await waitPositionsArea(page, 90000);

    if (!ok) {
      await sendTelegram(
        `HyperDash монитор\n${TRADER_URL}\n\nНе удалось дождаться таблицы позиций за отведённое время.`
      );
      return;
    }

    const curPositions = await grabPositions(page); // [{asset, side, size, sizeStr}]
    const state = loadState(); // {keys: { "ETH LONG": {size} }, lastHeartbeat}
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

    // Плановый отчёт раз в N часов
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

    // сохраняем новое состояние
    const nextKeys = {};
    for (const p of curPositions) nextKeys[keyOf(p)] = { size: p.size };
    state.keys = nextKeys;
    saveState(state);
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await browser.close();
  }
})();
