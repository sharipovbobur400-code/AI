#!/usr/bin/env sh
# Solar Factory WMS — Linux / macOS ishga tushirish
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "[XATO] Node.js topilmadi. Node.js 22 yoki 24 LTS ni o'rnating: https://nodejs.org"; exit 1
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env fayli yaratildi. Telegram bot uchun unga TELEGRAM_BOT_TOKEN yozing."
fi
echo "Solar Factory WMS: http://localhost:3000  (to'xtatish: Ctrl+C)"
# server to'xtab qolsa — 5 soniyadan so'ng avtomatik qayta ishga tushadi (to'xtatish: Ctrl+C ikki marta)
trap 'exit 0' INT TERM
while true; do
  node --no-warnings server/server.js
  echo "[$(date)] Server to'xtadi (kod $?) — 5 soniyadan so'ng qayta ishga tushadi"
  sleep 5
done
