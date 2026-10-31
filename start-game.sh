#!/usr/bin/env sh
# Ricochet Rumble launcher for macOS / Linux.
# Starts a small local server (launcher/server.py) that serves the game to this
# computer at http://localhost and the Wi-Fi phone controller to phones on the
# same network, then opens the game in Chrome or Edge.
exec python3 "$(dirname "$0")/launcher/server.py" "$@"
