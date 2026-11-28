#!/usr/bin/env bash
# Tests for the tablet app's server, relay and updater (plain Java, no Android SDK needed).
# Run from anywhere:  tablet-android/test/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
javac -d "$out" \
  "$here/app/src/main/java/com/ricochetrumble/tablet/GameServer.java" \
  "$here/app/src/main/java/com/ricochetrumble/tablet/Updater.java" \
  "$here/test/ServerTest.java"
java -cp "$out" ServerTest "$here"
