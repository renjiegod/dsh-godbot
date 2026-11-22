# Godbot Computer Host

Pair an Android Godbot app or an owner-authenticated local dsh web profile with this computer. The host connects out to a Godbot link v1 relay. It keeps its own identity and controller grants in an owner-only directory. The default location is `~/.local/share/godbot-computer-host`. Its local administration endpoint is a Unix socket readable only by that account.

## Install a standalone host

Choose a **host** archive for macOS Apple Silicon, Linux arm64 or Linux x64. It includes Node.js 24.14 and a native PTY worker. A Linux server needs a normal Unix user account and its configured shell. For desktop access install the matching **desktop** archive as well. Each archive has a detached publisher signature and checksum.

Obtain the publisher public key separately from a trusted source. Verify the downloaded archive before extracting or running its contents. For example, set `archive` to the filename and `trusted_key` to the local path of the verified PEM key, then run these commands in your downloads directory.

```sh
openssl dgst -sha256 -verify "$trusted_key" -signature "$archive.sig" "$archive" &&
tar -xzf "$archive" &&
"./${archive%.tar.gz}/install.sh" --trust-key "$trusted_key"
```

The host installer places the launcher in `~/.local/bin/godbot-computer` and retains versioned packages under `~/.local/share/godbot-computer/releases`. A subsequent install retains the preceding version of that component. Run the matching verified archive's `install.sh --rollback` to select it again and restart the user service when sessions are idle. Pairings and grants live outside package directories. Publish a production build with a protected release signing key and a Developer ID signed and notarized Mac helper. A local validation key authenticates only builds made by its local operator.

## Start and pair

```sh
godbot-computer start --relay wss://YOUR-RELAY/v1/link --name "My computer"
```

In another trusted local terminal run `godbot-computer pair --qr` to scan the offer with Android. For dsh web, run `godbot-computer pair` and paste the offer in Remote computers. Each offer expires after five minutes and enrolls one controller. Use `pair --out NEW_FILE` to create a private mode-0600 file. A second controller needs its own offer. Use `cancel-pair` to cancel an unused offer. The host blocks new screen capture while an offer or trusted settings is visible. A local development relay can use `ws://127.0.0.1:PORT/v1/link`.

`godbot-computer manage` opens the trusted controller and access settings in a local browser. `godbot-computer status` reports the relay connection, display availability, fingerprint and named shell account. `controllers` lists trusted identities. Newly paired controllers initially have **zero remembered grants**. The target can approve one request locally using its GUI prompt or `sessions` and `approve SESSION_ID`. `deny SESSION_ID` declines, and `stop SESSION_ID` ends an active connection. Use `--no-prompts` to decide entirely through the local CLI.

For unattended access deliberately grant a specific scope to one controller with `grant DEVICE_ID terminal`, `grant DEVICE_ID desktop.view` or `grant DEVICE_ID desktop.control`. Control includes view. `ungrant DEVICE_ID SCOPE` withdraws remembered access. `revoke DEVICE_ID` forgets that controller and ends its sessions. A shell grant conveys the full access of the named OS account, including access to its files. Run admin commands on an already trusted console. `history` displays recent connection metadata.

Use `install-service --relay URL [--headless]` to install a user LaunchAgent on macOS or user systemd service on Linux. `uninstall-service` removes that service and retains the identity. A graphical host belongs in the signed-in desktop user’s session. For headless Linux boot activation, the machine administrator can enable lingering for the designated user. An explicit `--home DIRECTORY` isolates a second host for testing; supply it to each CLI command that addresses that host.

## Graphical runtime

The graphical add-on includes the WebRTC media peer and the target adapter. Install a system FFmpeg with libvpx for VP8 encoding. On macOS, open **Finder → Home → Applications → Godbot Computer Host**. The add-on installer creates a stable `~/Applications/Godbot Computer Host.app` shortcut to the active signed package. In **System Settings → Privacy & Security**, enable this app under **Screen & System Audio Recording** for viewing and **Accessibility** for keyboard and pointer control, then check `status`. If the same-named app already belongs to another installation, the installer prints the active packaged app path. Signed application identity, OS privacy settings, screen lock and login-session state determine availability. Confirm the exact display and the target-side Stop control. On Linux install GTK 3, GStreamer and platform integration for the current seat. Debian and Ubuntu packages include `python3-gi`, `python3-dbus`, `python3-xlib`, `gir1.2-gtk-3.0`, `gir1.2-gstreamer-1.0`, `gstreamer1.0-plugins-good`, `gstreamer1.0-x`, `gstreamer1.0-pipewire`, `xdotool`, `zenity`, and `ffmpeg`. Wayland needs the compositor's ScreenCast and RemoteDesktop portals and a local screen selection where required. On an unsupported or locked seat the controller sees the reason. Headless terminal access remains available with its own grant.

## STUN and TURN

Set `GODBOT_COMPUTER_STUN_URL` on the host for operator-configured STUN discovery. Set `GODBOT_COMPUTER_TURN_ISSUER` and `GODBOT_COMPUTER_TURN_CREDENTIAL` for an enrolled host that can request ephemeral TURN credentials. The issuer URL uses HTTPS, or loopback HTTP for isolation tests. Inject secrets into the host environment or set `stun`, `turnIssuer`, `turnCredential` in a mode-0600 `network.json` in the host directory. Restart the service to pick up network configuration. TURN credentials are requested for approved desktop sessions and delivered over their Noise link. The headless terminal uses Noise link RPC.

## Build and validate from source

Build the shared mobile link first with `npm ci` and `npm run build` in dsh-godbot. `node computer-host/cli.mjs` runs the same CLI. Source checkouts use a Python 3 standard-library terminal worker until `GODBOT_PTY_WORKER` points at a compiled native worker. To build a native executable run `go build -o /path/to/godbot-pty .` in `computer-host/pty-worker`. The standalone packages use this compiled implementation.

Run the coordinator tests through the real Go link relay using `GODBOT_RELAY_BIN=/path/to/godbot-relay node --test test/computer-host/host.test.js`. Run `go vet ./...` and `go test ./...` in both the PTY and RTC modules. To build an add-on for the current workstation, run `node computer-host/native/build.mjs`. Its `--rollback` option selects the previous source-built native runtime.

Build the signed archives with `node scripts/package-computer-host.mjs --target darwin-arm64 --out DIRECTORY --signing-key PRIVATE_PEM` or target `linux-arm64` / `linux-x64`. Use a P-256 ECDSA key and distribute its public half independently. The packager verifies the pinned Node archive checksum, cross-compiles the Go helpers, includes third-party license notices, and writes signed manifests plus detached archive signatures. On macOS build and sign the capture application before packaging; `--mac-app PATH` selects an existing signed build.
