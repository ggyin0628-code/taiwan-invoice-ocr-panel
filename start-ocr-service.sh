#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/ocr-service"

echo "財務收據整理面板：啟動 PaddleOCR service"
echo "工作目錄：$(pwd)"

PORT_PIDS=$(lsof -ti tcp:8765 2>/dev/null || true)
if [ -n "$PORT_PIDS" ]; then
  echo "8765 port 已被佔用，正在停止舊服務：$PORT_PIDS"
  kill $PORT_PIDS 2>/dev/null || true
  sleep 1
fi

if [ ! -d ".venv" ]; then
  echo "找不到 Python .venv，正在建立..."
  python3 -m venv .venv
fi

source .venv/bin/activate

if [ ! -f ".venv/.requirements-installed" ]; then
  echo "安裝 PaddleOCR service 套件..."
  python -m pip install --upgrade pip
  pip install -r requirements.txt
  touch .venv/.requirements-installed
fi

echo "啟動 PaddleOCR service：http://127.0.0.1:8765"
uvicorn app:app --host 127.0.0.1 --port 8765
