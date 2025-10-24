import json, os, re, sys, time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

TRADER_URL = os.getenv("TRADER_URL")
STATE_PATH = Path("last_positions.json")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
}

def load_state():
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}

def save_state(state):
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

def find_next_data(html):
    soup = BeautifulSoup(html, "html.parser")
    tag = soup.find("script", id="__NEXT_DATA__")
    if tag and tag.string:
        return json.loads(tag.string)
    for s in soup.find_all("script"):
        if s.string and "__NEXT_DATA__" in s.string:
            m = re.search(r'\{.*\}', s.string, re.S)
            if m:
                return json.loads(m.group(0))
    return None

def walk(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k, v
            yield from walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk(v)

def normalize_positions(raw_positions):
    norm = []
    for p in raw_positions:
        if not isinstance(p, dict):
            continue
        symbol = p.get("symbol") or p.get("coin") or p.get("asset") or p.get("token") or p.get("name")
        side = p.get("side")
        if side is None:
            is_long = p.get("isLong")
            if isinstance(is_long, bool):
                side = "long" if is_long else "short"
        if isinstance(side, bool):
            side = "long" if side else "short"
        size = p.get("size") or p.get("sz") or p.get("positionSize") or p.get("szi") or p.get("qty")
        try:
            size = float(size)
        except Exception:
            continue
        if not symbol or size == 0:
            continue
        norm.append({"symbol": str(symbol), "side": side or "unknown", "size": size})
    return norm

def extract_positions_from_next(json_blob):
    candidates = []
    def _walk(obj):
        if isinstance(obj, dict):
            for k, v in obj.items():
                yield k, v
                yield from _walk(v)
        elif isinstance(obj, list):
            for v in obj:
                yield from _walk(v)
    for k, v in _walk(json_blob):
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            keys = set()
            for x in v[:3]:
                keys |= set(x.keys())
            if {"symbol","side","size"} <= keys or {"coin","isLong","szi"} & keys:
                candidates.append(v)
        if k == "positions" and isinstance(v, list):
            candidates.append(v)
    for v in candidates:
        norm = normalize_positions(v)
        if norm:
            return norm
    return []

def fetch_positions():
    r = requests.get(TRADER_URL, headers=HEADERS, timeout=30)
    r.raise_for_status()
    data = find_next_data(r.text)
    if data:
        positions = extract_positions_from_next(data)
        if positions:
            return positions
    return []

def to_index(positions):
    idx = {}
    for p in positions:
        key = f"{p['symbol']}:{p['side']}"
        idx[key] = p["size"]
    return idx

def diff_positions(prev_idx, curr_idx, size_tol=1e-9):
    opened, closed, resized = [], [], []
    for k in curr_idx:
        if k not in prev_idx:
            opened.append((k, curr_idx[k]))
        else:
            if abs(curr_idx[k] - prev_idx[k]) > size_tol:
                resized.append((k, prev_idx[k], curr_idx[k]))
    for k in prev_idx:
        if k not in curr_idx:
            closed.append((k, prev_idx[k]))
    return opened, closed, resized

def send_telegram(msg):
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if not (token and chat_id):
        print("[log] TELEGRAM not configured, message:\n", msg)
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = {"chat_id": chat_id, "text": msg, "disable_web_page_preview": True}
    requests.post(url, data=data, timeout=20)

def send_discord(msg):
    wh = os.getenv("DISCORD_WEBHOOK_URL")
    if not wh:
        return
    requests.post(wh, json={"content": msg}, timeout=20)

def notify(msg):
    send_telegram(msg)
    send_discord(msg)

def main():
    if not TRADER_URL:
        print("TRADER_URL is not set", file=sys.stderr)
        sys.exit(1)

    prev_state = load_state()
    prev_idx = prev_state.get("index", {})
    curr_positions = fetch_positions()
    curr_idx = to_index(curr_positions)

    opened, closed, resized = diff_positions(prev_idx, curr_idx)

    if not (opened or closed or resized):
        print("No changes.")
        return

    parts = [f"🔔 Hyperdash мониторинг\n{TRADER_URL}"]
    if opened:
        parts.append("🟢 ОТКРЫТО:")
        for k, v in opened:
            sym, side = k.split(":")
            parts.append(f"• {sym} {side} — {v:g}")
    if closed:
        parts.append("🔴 ЗАКРЫТО:")
        for k, v in closed:
            sym, side = k.split(":")
            parts.append(f"• {sym} {side} — было {v:g}")
    if resized:
        parts.append("🟨 ИЗМЕНЕНО:")
        for k, old, new in resized:
            sym, side = k.split(":")
            parts.append(f"• {sym} {side}: {old:g} → {new:g}")

    msg = "\n".join(parts)
    notify(msg)

    save_state({"index": curr_idx, "fetched_at": int(time.time())})

if __name__ == "__main__":
    main()
