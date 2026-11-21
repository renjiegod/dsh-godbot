#!/bin/sh
set -eu
Xvfb "$DISPLAY" -screen 0 1200x760x24 -nolisten tcp &
count=0
until xdotool getdisplaygeometry >/dev/null 2>&1; do
  count=$((count + 1))
  if [ "$count" -gt 100 ]; then exit 1; fi
  sleep 0.05
done
mkdir -p /profile/work
cd /profile/work
openbox >/dev/null 2>&1 &
exec chromium-browser --no-sandbox --disable-dev-shm-usage --disable-background-networking --disable-sync --disable-gpu --no-first-run --remote-debugging-port=9222 --user-data-dir=/profile --window-size=1200,760 about:blank
