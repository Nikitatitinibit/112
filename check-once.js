import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const TRADER_URL =
  "https://hyperdash.info/trader/0xc2a30212a8DdAc9e123944d6e29FADdCe994E5f2";
const STATE_FILE = path.join(process.cwd(), "state.json");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const EXEC_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

// === Утилита отправки сообщений в Telegram ===
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

// === Функции состояния ===
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

// === Разница между снимками ===
function diff(prevArr, curArr) {
  const prev = new Set(prevArr || []);
  const cur = new Set(curArr || []);
  const added = [...cur].filter((x) => !prev.has(x));
  const removed = [...prev].filter((x) => !cur.has(x));
  return { added, removed };
}

// === Основная логика ===
async function takeSnapshot(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  );
  await page.goto(TRADER_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForTimeout(3000);

  const snap = await page.evaluate(() => {
    const normalize = (s) => s.replace(/\s+/g, " ").trim();
    const harvest = (root) => {
      if (!root) return [];
      const rows = Array.from(root.querySelectorAll("tr")).map((r) =>
        Array.from(r.querySelectorAll("td,th"))
          .map((td) => normalize(td.innerText))
          .join(" | ")
      );
      return rows.filter(Boolean);
    };

    const posRoot = document.querySelector("#positions, .open-positions");
    const tradeRoot = document.querySelector("#trades, .recent-trades");
    const positions = harvest(posRoot);
    const trades = harvest(tradeRoot);

    return { ts: Date.now(), positions, trades };
  });

  await page.close();
  return snap;
}

// === Основной запуск ===
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
    const prev = loadState();
    const snap = await takeSnapshot(browser);

    const pos = diff(prev.positions, snap.positions);
    const trd = diff(prev.trades, snap.trades);

    const messages = [];
    if (pos.added.length)
      messages.push("✅ Новые позиции:\n" + pos.added.join("\n"));
    if (pos.removed.length)
      messages.push("❌ Закрытые позиции:\n" + pos.removed.join("\n"));
    if (trd.added.length)
      messages.push("📈 Новые сделки:\n" + trd.added.join("\n"));

    if (messages.length) {
      await sendTelegram(messages.join("\n\n"));
    } else {
      console.log("Нет изменений.");
    }

    saveState({
      positions: snap.positions,
      trades: snap.trades,
      lastChecked: snap.ts,
    });
  } catch (e) {
    console.error("Ошибка:", e);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
