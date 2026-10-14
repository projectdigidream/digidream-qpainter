#!/usr/bin/env bash
#
# qPainter's desktop app (Electron), from the same web build as the browser.
#
#   scripts/package_electron.sh              macOS (arm64 + x64), Windows x64 and Linux x64
#   scripts/package_electron.sh --mac        just macOS   (also --win, --linux)
#   scripts/package_electron.sh --dir        an unpacked app for this machine, faster
#
# The payload is dist/ as `npm run build` makes it, so browser and desktop run
# byte-identical code. Windows builds on any machine: the .exe is not edited
# (signAndEditExecutable false), which is what would need Wine.
#
# Output: electron/dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -d node_modules ]] || npm ci --no-audit --no-fund
npm run build >/dev/null
rm -rf electron/payload && cp -R dist electron/payload
cd electron
[[ -d node_modules ]] || npm install --no-audit --no-fund
case "${1:-}" in
  --dir)   npx electron-builder --dir ;;
  --mac)   npx electron-builder --mac ;;
  --win)   npx electron-builder --win ;;
  --linux) npx electron-builder --linux ;;
  "")      npx electron-builder --mac --win --linux ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac
echo "package_electron: electron/dist/"
