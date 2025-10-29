// check-once.js — отслеживание ТОЛЬКО факта появления/исчезновения позиций
// Сравниваем по стабильным ключам SYMBOL:SIDE (например "ETH:LONG")

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const MAX = 3900; // безопаснее лимита 4096
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
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { keys: [] };
  }
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function diff(prevArr, curArr) {
  const prev = new Set(prevArr || []);
  const cur = new Set(curArr || []);
  return {
    added: [...cur].filter((x) => !prev.has(x)),
    removed: [...prev].filter((x) => !cur.has(x)),
  };
}

// ---------- парсинг стабильных ключей на странице ----------
function uniq(a) { return [...new Set(a)]; }

// Пробуем достать из __NEXT_DATA__ (самый надёжный способ)
function extractFromNextData(json) {
  const keys = [];
  function* walk(o) {
    if (Array.isArray(o)) for (const v of o) yield* walk(v);
    else if (o && typeof o === "object") {
      yield o;
      for (const v of Object.values(o)) yield* walk(v);
    }
  }
  for (const o of walk(json)) {
    const symbol = o.symbol || o.asset || o.coin || o.name;
    let side = null;
    if (typeof o.isLong === "boolean") side = o.isLong ? "LONG" : "SHORT";
    else if (o.side) side = String(o.side).toUpperCase();
    if (
      symbol &&
      (side === "LONG" || side === "SHORT") &&
      /^[A-Z0-9.\-:]{2,15}$/.test(String(symbol).toUpperCase())
    ) {
      keys.push(`${String(symbol).toUpperCase()}:${side}`);
    }
  }
  return uniq(keys);
}

// Фолбэк: берём тексты строк и выуживаем SYMBOL + LONG/SHORT
function extractFromText(lines) {
  const keys = [];
  for (const raw of lines) {
    const s = (raw || "").toUpperCase();
    // Форматы типа: "ETH 10x | LONG | ..." или "BTC | LONG | ..."
    let m =
      s.match(/^\s*([A-Z0-9.\-:]{2,15})\s+\d+x.*\b(LONG|SHORT)\b/) ||
      s.match(/^\s*([A-Z0-9.\-:]{2,15})\s*[| ].*?\b(LONG|SHORT)\b/);
    if (m) {
      const sym = m[1].toUpperCase();
      const side = m[2].toUpperCase();
      if (sym !== "ASSET" && sym !== "TYPE" && (side === "LONG" || side === "SHORT")) {
        keys.push(`${sym}:${side}`);
      }
    }
  }
  return uniq(keys);
}

async function getStableKeys(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  );
  await page.setViewport({ width: 1366, height: 900 });

  await page.goto(TRADER_URL, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(2500);

  // 1) __NEXT_DATA__
  const nextKeys = await page.evaluate(() => {
    const el = document.querySelector("#__NEXT_DATA__");
    if (!el) return null;
    try { return el.textContent; } catch { return null; }
  });

  if (nextKeys) {
    try {
      const json = JSON.parse(nextKeys);
      const keys = extractFromNextData(json);
      if (keys.length) {
        await page.close();
        return keys;
      }
    } catch {}
  }

  // 2) Фолбэк по тексту
  const textLines = await page.evaluate(() => {
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
  return extractFromText(textLines);
}

// ---------- main ----------
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
    const prev = loadState(); // { keys: [...] }
    const keys = await getStableKeys(browser);
    const sorted = [...keys].sort();

    const { added, removed } = diff(prev.keys, sorted);

    if (added.length || removed.length) {
      const fmt = (k) => k.replace(":", " ");
      const blocks = [];
      if (added.length) blocks.push("Открыты позиции:\n" + added.map((k) => "• " + fmt(k)).join("\n"));
      if (removed.length) blocks.push("Закрыты позиции:\n" + removed.map((k) => "• " + fmt(k)).join("\n"));
      await sendTelegram(`HyperDash монитор\n${TRADER_URL}\n\n` + blocks.join("\n\n"));
    } else {
      console.log("No changes.");
    }

    saveState({ keys: sorted, lastChecked: Date.now() });
  } catch (e) {
    console.error("Error:", e);
    try { await sendTelegram(`⚠️ Ошибка монитора: ${e.message}`); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();


