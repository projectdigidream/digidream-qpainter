#!/usr/bin/env bash
# Build an Android APK (debug-signed, for sideloading).
#   ./build-apk.sh           build → qPainter.apk
#   ./build-apk.sh install   build and install on a USB-connected device (USB debugging on)
set -euo pipefail
cd "$(dirname "$0")"

# Android Studio's bundled JDK and the default SDK location on macOS; override via env if yours differ.
: "${JAVA_HOME:=/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export JAVA_HOME ANDROID_HOME

[ -d node_modules ] || npm install
npm run build
npx cap sync android

(cd android && ./gradlew assembleDebug -q)
cp android/app/build/outputs/apk/debug/app-debug.apk qPainter.apk
echo "APK: $PWD/qPainter.apk"

if [ "${1:-}" = "install" ]; then
  "$ANDROID_HOME/platform-tools/adb" install -r qPainter.apk
  "$ANDROID_HOME/platform-tools/adb" shell monkey -p com.digidream.qpainter -c android.intent.category.LAUNCHER 1 >/dev/null
fi
