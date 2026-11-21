FROM alpine:3.22
RUN apk add --no-cache chromium socat font-noto && adduser -D -u 10001 worker && mkdir /profile && chown worker /profile
RUN apk add --no-cache xvfb openbox xdotool scrot xterm busybox-extras
COPY start.sh /usr/local/bin/godbot-desktop
USER worker
ENV HOME=/home/worker DISPLAY=:99
VOLUME ["/profile"]
ENTRYPOINT ["/bin/sh","/usr/local/bin/godbot-desktop"]
