// check-once.js — отслеживание ТОЛЬКО ОТКРЫТИЯ/ЗАКРЫТИЯ ПОЗИЦИЙ (без trades)

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const TRADER_URL =
  process.env.TRADER_URL ||
  "https://hyperdash.info/trader/0xc2a30212a8DdAc9e123944d6e29FADdCe994E5f2";

const STATE_FILE = path.join(process.cwd(), "state.json");

const TELEGRAM_TOKEN =
  process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const EXEC_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Telegram (без Markdown, с проверкой ответа)
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: "true",
  });
  const res = await fetch(url, { method: "POST", body });
  const txt = await res.text();
  if (!res.ok) {
    console.error("Telegram error:", res.status, txt);
    throw new Error("Telegram send failed");
  }
}

// ── Хранение снапшота
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { positions: [] };
  }
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// простая разница множеств строк
function diff(prevArr, curArr) {
  const prev = new Set(prevArr || []);
  const cur = new Set(curArr || []);
  return {
    added: [...cur].filter((x) => !prev.has(x)),
    removed: [...prev].filter((x) => !cur.has(x)),
  };
}

// ── Снятие снимка страницы (вытаскиваем «Asset Positions»)
async function takeSnapshot(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  );
  await page.setViewport({ width: 1366, height: 900 });

  await page.goto(TRADER_URL, { waitUntil: "networkidle2", timeout: 120000 });

  // даём SPA дорендериться
  await sleep(3000);

  const positions = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    // ищем блоки «Asset Positions»/«Positions»
    const roots = [];
    document.querySelectorAll("*").forEach((el) => {
      const t = (el.textContent || "").toLowerCase();
      if (t.includes("asset positions") || t === "positions") {
        roots.push(el.closest("section") || el.parentElement || el);
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
  return positions;
}

// ── Main
(async () => {
  console.log("🔍 Puppeteer path:", EXEC_PATH);

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
    const prev = loadState(); // { positions: [...] }
    const curPositions = await takeSnapshot(browser);

    const pos = diff(prev.positions, curPositions);

    if (pos.added.length || pos.removed.length) {
      const blocks = [];
      if (pos.added.length)
        blocks.push(
          `Открыты позиции (${pos.added.length}):\n` +
            pos.added.slice(0, 10).map((x) => `• ${x}`).join("\n")
        );
      if (pos.removed.length)
        blocks.push(
          `Закрыты позиции (${pos.removed.length}):\n` +
            pos.removed.slice(0, 10).map((x) => `• ${x}`).join("\n")
        );

      await sendTelegram(`HyperDash монитор\n${TRADER_URL}\n\n${blocks.join("\n\n")}`);
    } else {
      console.log("No changes.");
    }

    saveState({ positions: curPositions, lastChecked: Date.now() });
  } catch (e) {
    console.error("Error:", e);
    try {
      await sendTelegram(`⚠️ Ошибка монитора: ${e.message}`);
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();


