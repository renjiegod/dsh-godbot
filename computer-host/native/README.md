# Godbot desktop helper

Install the graphical helper on the target account. The standalone host CLI can run a terminal on a machine with no graphical dependencies. These instructions add a real graphical desktop to that installation.

## macOS

Install the Go toolchain, Apple command line tools and FFmpeg with the libvpx encoder. Run the build command from the Godbot package.

```sh
node computer-host/native/build.mjs
open "$HOME/Library/Application Support/Godbot Computer Host/native/Godbot Computer Host.app"
```

Open **Screen Recording** to allow viewing and **Accessibility** to allow pointer and keyboard input. The setup window also opens the installed local controller manager. macOS can require the helper to be relaunched after a permission change. The active user must be logged in with the display unlocked. During sharing the Godbot menu bar item names the controller and offers **Stop sharing**.

The build signs the app using the account’s single valid Apple Development identity if available. To select a specific identity, set `GODBOT_MAC_SIGNING_IDENTITY`. A local ad-hoc build is possible if no identity is available. A signed and notarized release for other Macs requires the publisher's distribution credentials. macOS grants are associated with the helper’s identity. Run `codesign --verify --strict` against the installed app when verifying an installation.

## Linux

Install Go, FFmpeg with libvpx, and the desktop dependencies on the target, then build under the logged-in user. On Debian-family distributions the packages for the runtime include:

```sh
apt install ffmpeg python3-gi python3-dbus python3-xlib gir1.2-gtk-3.0 gir1.2-gstreamer-1.0 \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-x gstreamer1.0-pipewire xdotool wayland-utils
node computer-host/native/build.mjs
```

Start the host in the graphical user's session with its display and D-Bus environment. X11 requires XTEST for input. Wayland requires PipeWire and the running desktop’s ScreenCast and RemoteDesktop portal backends. Select a display locally in the ScreenCast chooser. A request for control prompts separately for the same display and pointer/keyboard access. The stream is black while this second chooser is visible; canceling preserves an authorized view. The host checks a real login/session-lock provider. If it cannot establish that the seat is unlocked, it withholds graphical access.

X11 captures the selected monitor with GStreamer and injects input through XTEST. Wayland uses only the PipeWire file descriptor and stream node returned by the portal. Normal key input is mapped through the active keymap. For a Unicode character missing from that layout, the Wayland host uses the Linux input method’s Unicode entry sequence. Committed text for those characters depends on the target application's input method; the GTK validation covers this case. The target's **Stop sharing** window ends the native processes.

## Media and installation

The controller sends a receive-only WebRTC video offer with a reliable, ordered `godbot-input-v1` channel. The target encodes VP8 at up to 1280×960 and 15 fps. The bandwidth-saver profile caps capture at 960×540, targets 350 kbit/s, and permits encoder frame drops under pressure. Pion terminates the WebRTC connection in a separate process. Capture, encoder and media processes use inherited private descriptors. Closing the session waits for process teardown and releases held inputs. Local revocation of Accessibility ends input while an approved screen stream continues. Losing screen permission, the graphical login or the selected display ends sharing.

`GODBOT_DESKTOP_RUNTIME` selects the installation directory. `GODBOT_DESKTOP_FFMPEG` selects an encoder executable when FFmpeg is outside the service's PATH. The Linux default runtime is under `$XDG_DATA_HOME/godbot-computer/native`, or `~/.local/share/godbot-computer/native`. The most recent replaced complete runtime is stored under `previous`; `node computer-host/native/build.mjs --rollback` restores it. Host identities, scope grants and terminal sessions have separate storage.

ICE normally chooses its own UDP ports. A target administrator can set `GODBOT_DESKTOP_UDP_PORT` to a port from 1024 to 65535 for a bounded UDP listener, and `GODBOT_DESKTOP_PUBLIC_IPS` to a comma-separated set of IPs when that port is mapped through NAT. The mappings must retain the same port. `GODBOT_DESKTOP_RELAY_ONLY=1` requires a usable TURN allocation for media. These settings are interpreted on the target.

## Local graphical E2E

The included Linux test opens a real GTK input field and a Chromium viewer on a disposable X11 seat with a running MATE lock service. It verifies decodable VP8, pointer clicks, Unicode text and physical key receipt, view-only behavior, stale geometry rejection, release of control, and stream termination on lock. In a Linux shell with the relevant dependencies, build the native runtime and run:

```sh
computer-host/native/test/x11-run.sh
```

The accompanying Dockerfile installs these testing dependencies. For a macOS-driven container run, compile `computer-host/native/rtc` for the container’s Linux architecture, place it and an executable copy of `linux/desktop.py` named `godbot-screen` in a private test runtime, and mount it at `GODBOT_DESKTOP_RUNTIME`. The test uses Node, Chromium, python3, xdotool, DBus, Openbox, Xvfb and mate-screensaver. On newer Node distributions install the `ws` package for the test driver if it is missing.

Inspect the WebRTC path through the controller’s connection statistics. Encoding and capture code lives in this package. Its system FFmpeg, GStreamer and compositor plugins are selected at install time, so record the installed codec and plugin versions in deployment and validation records. The Pion module graph and integrity checks are pinned in `rtc/go.mod` and `rtc/go.sum`.
