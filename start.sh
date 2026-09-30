#!/usr/bin/env bash
# Launch the texture editor for testing.
#   ./start.sh         dev server with hot reload
#   ./start.sh prod    production build + preview (service worker / offline enabled)
# Both listen on your LAN so you can open the printed Network URL on a phone.
set -euo pipefail
cd "$(dirname "$0")"

[ -d node_modules ] || npm install

PORT=5173
URL="http://localhost:$PORT"
# open the browser once the server is up (macOS: open, Linux: xdg-open)
(for _ in $(seq 50); do curl -s "$URL" >/dev/null && break; sleep 0.2; done
 command -v open >/dev/null && open "$URL" || xdg-open "$URL" 2>/dev/null || true) &

if [ "${1:-}" = "prod" ]; then
  npm run build
  exec npx vite preview --host --port "$PORT" --strictPort
else
  exec npx vite --host --port "$PORT" --strictPort
fi
