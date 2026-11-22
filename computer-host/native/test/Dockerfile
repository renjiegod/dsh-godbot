FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates nodejs node-ws dbus-x11 xvfb xauth x11-utils xterm xdotool \
  python3 python3-dbus python3-gi python3-xlib gir1.2-gtk-3.0 gir1.2-gstreamer-1.0 \
  gstreamer1.0-x gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pipewire \
  ffmpeg chromium openbox mate-screensaver \
  && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash godbotqa
USER godbotqa
ENV HOME=/home/godbotqa
