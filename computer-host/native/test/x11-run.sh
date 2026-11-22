#!/bin/sh
set -eu
export GODBOT_DESKTOP_TEST_DIR="$(mktemp -d)"
export XDG_RUNTIME_DIR="$GODBOT_DESKTOP_TEST_DIR/runtime"
export XDG_CURRENT_DESKTOP=MATE
export XDG_SESSION_TYPE=x11
mkdir -m 700 "$XDG_RUNTIME_DIR"
exec dbus-run-session -- xvfb-run -a -s '-screen 0 1280x720x24 -nolisten tcp' sh -eu -c '
  openbox >"$GODBOT_DESKTOP_TEST_DIR/openbox.log" 2>&1 &
  for i in $(seq 1 30); do xprop -root _NET_SUPPORTING_WM_CHECK | grep -q "0x" && break; sleep 0.1; done
  mate-screensaver --no-daemon >"$GODBOT_DESKTOP_TEST_DIR/screensaver.log" 2>&1 &
  python3 "$1/x11-window.py" >"$GODBOT_DESKTOP_TEST_DIR/window.log" 2>&1 &
  for i in $(seq 1 30); do
    if test -s "$GODBOT_DESKTOP_TEST_DIR/point" && mate-screensaver-command --query >/dev/null 2>&1; then break; fi
    sleep 0.3
  done
  exec node "$1/x11-browser.mjs"
' sh "$(dirname "$0")"
