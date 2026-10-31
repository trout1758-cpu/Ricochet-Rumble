#!/usr/bin/env sh
# Ricochet Rumble launcher for macOS / Linux.
# Serves the game on http://localhost (needed for Web Bluetooth) and opens it.
set -e
cd "$(dirname "$0")/game"
PORT="${PORT:-8080}"
URL="http://localhost:$PORT/"

echo ""
echo "  Ricochet Rumble is running at $URL"
echo "  Press Ctrl+C to stop."
echo ""

(
  sleep 1
  if command -v open >/dev/null 2>&1; then
    open -a "Google Chrome" "$URL" 2>/dev/null || open -a "Microsoft Edge" "$URL" 2>/dev/null || open "$URL"
  elif command -v google-chrome >/dev/null 2>&1; then
    google-chrome "$URL" >/dev/null 2>&1
  elif command -v chromium >/dev/null 2>&1; then
    chromium "$URL" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1
  fi
) &

exec python3 -m http.server "$PORT" --bind localhost
