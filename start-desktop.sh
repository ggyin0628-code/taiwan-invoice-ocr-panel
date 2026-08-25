#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

echo "財務收據整理面板：正式桌機啟動"
echo "工作目錄：$(pwd)"

PORT_PIDS=$(lsof -ti tcp:3000 2>/dev/null || true)
if [ -n "$PORT_PIDS" ]; then
  echo "3000 port 已被佔用，正在停止舊服務：$PORT_PIDS"
  kill $PORT_PIDS 2>/dev/null || true
  sleep 1
fi

if [ ! -d "node_modules" ]; then
  echo "找不到 node_modules，先安裝套件..."
  npm ci
fi

echo "建立正式版本..."
npm run build

echo "系統檢查..."
npm run doctor

echo "啟動財務收據整理面板..."
echo "請在瀏覽器開啟：http://localhost:3000"
open "http://localhost:3000" >/dev/null 2>&1 || true
npm run start -- -p 3000
