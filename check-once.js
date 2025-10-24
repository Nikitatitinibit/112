// check-once.js — снимает снапшот с Hyperdash и шлёт уведомления в TG

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { setTimeout as delay } from "timers/promises";

const TRADER_URL =
  "https://hyperdash.info/trader/0xc2a30212a8DdAc9e123944d6e29FADdCe994E5f2";
const STATE_FILE = path.join(process.cwd(), "state.json");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

// --- Telegram ---
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
    }),
  });
}

// --- State ---
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { positions: [], trades: [] };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function diff(prevArr, curArr) {
  const prev = new Set(prevArr || []);
  const cur = new Set(curArr || []);
  const added = [...cur].filter((x) => !prev.has(x));
  const removed = [...prev].filter((x) => !cur.has(x));
  return { added, removed };
}

// --- Grab data from page ---
async function takeSnapshot(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  );
  await page.setViewport({ width: 1366, height: 900 });

  await page.goto(TRADER_URL, { waitUntil: "networkidle2", timeout: 120000 });

  // даём SPA дорендериться
  await delay(3000);

  const snap = await page.evaluate(() => {
    const normalize = (s) => s.replace(/\s+/g, " ").trim();

    const harvest = (root) => {
      if (!root) return [];
      const tbl = Array.from(root.querySelectorAll("tr"))
        .map((r) =>
          Array.from(r.querySelectorAll("th,td"))
            .map((td) => normalize(td.innerText))
            .filter(Boolean)
            .join(" | ")
        )
        .filter(Boolean);

      const lst = Array.from(
        root.querySelectorAll("li, .row, .trade-row, [role='row']")
      )
        .map((n) => normalize(n.innerText))
        .filter(Boolean);

      return [...new Set([...tbl, ...lst])];
    };

    const byHeader = (rx) =>
      Array.from(document.querySelectorAll("h1,h2,h3,h4"))
        .filter((h) => rx.test(h.textContent || ""))
        .map((h) => h.closest("section") || h.parentElement)
        .filter(Boolean);

    const posRoots = [
      document.querySelector("[data-testid*='positions']"),
      document.querySelector(".open-positions"),
      document.querySelector("#positions"),
      ...byHeader(/positions/i),
    ].filter(Boolean);

    const tradeRoots = [
      document.querySelector("[data-testid*='trades']"),
      document.querySelector(".recent-trades,.activity,.trades"),
      document.querySelector("#trades"),
      ...byHeader(/(trades|activity|history)/i),
    ].filter(Boolean);

    const positions = [...new Set(posRoots.flatMap(harvest))];
    const trades = [...new Set(tradeRoots.flatMap(harvest))];

    return { ts: Date.now(), positions, trades };
  });

  await page.close();
  return snap;
}

(async () => {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("No TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in env");
    process.exit(1);
  }

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
    const prev = loadState();
    const snap = await takeSnapshot(browser);

    const pos = diff(prev.positions, snap.positions);
    const trd = diff(prev.trades, snap.trades);

    const blocks = [];
    if (pos.added.length)
      blocks.push(
        `✅ *Открыты позиции* (${pos.added.length}):\n` +
          pos.added.slice(0, 10).map((x) => `• ${x}`).join("\n")
      );
    if (pos.removed.length)
      blocks.push(
        `❌ *Закрыты позиции* (${pos.removed.length}):\n` +
          pos.removed.slice(0, 10).map((x) => `• ${x}`).join("\n")
      );
    if (trd.added.length)
      blocks.push(
        `📈 *Новые сделки/активности* (${trd.added.length}):\n` +
          trd.added.slice(0, 10).map((x) => `• ${x}`).join("\n")
      );

    if (blocks.length) {
      await sendTelegram(
        `HyperDash монитор\nАдрес: ${TRADER_URL}\n\n${blocks.join("\n\n")}`
      );
    } else {
      console.log("No changes.");
    }

    saveState({
      positions: snap.positions,
      trades: snap.trades,
      lastChecked: snap.ts,
    });
  } catch (e) {
    console.error("Error:", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
