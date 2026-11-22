#!/usr/bin/python3
"""Godbot's per-seat Linux helper. The coordinator owns the inherited pipes."""

import json
import math
import os
import shutil
import time
import subprocess
import sys
import threading
import uuid
import zlib


def emit(message):
    print(json.dumps(message, ensure_ascii=True), flush=True)


def unavailable(message):
    if len(sys.argv) > 1 and sys.argv[1] == "probe":
        emit(dict(available=False, control=False, reason=message, displays=[]))
    else:
        emit(dict(type="ended", reason=message))
    sys.exit(0)


if not (os.getenv("DISPLAY") or os.getenv("WAYLAND_DISPLAY")):
    unavailable("No graphical session")
try:
    import dbus
    import dbus.mainloop.glib
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("Gst", "1.0")
    from gi.repository import Gdk, GLib, Gst, Gtk

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    if not Gtk.init_check(None)[0]:
        unavailable("No accessible graphical session")
    Gst.init(None)
    bus = dbus.SessionBus()
except (
    ImportError,
    ValueError,
    RuntimeError,
    GLib.Error if "GLib" in globals() else OSError,
) as error:
    unavailable(
        "Install the Godbot Linux desktop dependencies and start the host in the user session"
    )

wayland = os.getenv("XDG_SESSION_TYPE") == "wayland" or bool(
    os.getenv("WAYLAND_DISPLAY")
)
display = Gdk.Display.get_default()
PORTAL = "org.freedesktop.portal.Desktop"
ROOT = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
CAST = "org.freedesktop.portal.ScreenCast"
PROPS = "org.freedesktop.DBus.Properties"
xdisplay = None
portal = None
can_input = False
if wayland:
    try:
        portal = bus.get_object(PORTAL, ROOT)
        properties = dbus.Interface(portal, PROPS)
        if not int(properties.Get(CAST, "AvailableSourceTypes")) & 1:
            unavailable("The portal cannot share a monitor")
        try:
            can_input = int(properties.Get(REMOTE, "AvailableDeviceTypes")) & 3 == 3
        except dbus.DBusException:
            pass
    except dbus.DBusException:
        unavailable("The graphical session has no ScreenCast portal")
else:
    try:
        from Xlib import X, display as xlib_display
        from Xlib.ext import xtest, randr

        xdisplay = xlib_display.Display()
        can_input = xdisplay.has_extension("XTEST")
    except Exception:
        unavailable("X11 session is inaccessible or python3-xlib is missing")
if not Gst.ElementFactory.find("pipewiresrc" if wayland else "ximagesrc"):
    unavailable("The graphical capture plugin is missing")


def select_lock_probe():
    # logind is authoritative for a real login. Desktop screensaver providers
    # additionally cover GNOME, KDE and other seats which publish GetActive.
    probes = []
    try:
        sysbus = dbus.SystemBus()
        manager = dbus.Interface(
            sysbus.get_object("org.freedesktop.login1", "/org/freedesktop/login1"),
            "org.freedesktop.login1.Manager",
        )
        sid = os.getenv("XDG_SESSION_ID")
        path = manager.GetSession(sid) if sid else manager.GetSessionByPID(os.getpid())
        props = dbus.Interface(sysbus.get_object("org.freedesktop.login1", path), PROPS)

        def logged_in():
            state = props.GetAll("org.freedesktop.login1.Session")
            return (
                bool(state["Active"])
                and not bool(state["LockedHint"])
                and int(state["User"][0]) == os.getuid()
            )

        logged_in()
        probes.append(logged_in)
    except (dbus.DBusException, KeyError):
        pass
    for name, path in [
        ("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver"),
        ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"),
        ("org.xfce.ScreenSaver", "/org/xfce/ScreenSaver"),
        ("org.mate.ScreenSaver", "/org/mate/ScreenSaver"),
    ]:
        try:
            if not bus.name_has_owner(name):
                continue
            iface = dbus.Interface(bus.get_object(name, path), name)
            iface.GetActive(timeout=1)
            probes.append(lambda iface=iface: not bool(iface.GetActive(timeout=1)))
        except dbus.DBusException:
            pass

    def unlocked():
        if not probes:
            return False
        try:
            return all(probe() for probe in probes)
        except dbus.DBusException:
            return False

    return unlocked


unlocked = select_lock_probe()


def wayland_revision():
    if shutil.which("wayland-info") is None:
        raise RuntimeError(
            "Install wayland-utils to monitor display rotation and scale"
        )
    result = subprocess.run(
        ["wayland-info"], capture_output=True, text=True, timeout=2, check=True
    )
    # wl_output geometry includes physical orientation and current compositor
    # scale; logical geometry from xdg_output distinguishes offset monitors.
    keys = (
        "x: ",
        "physical_width:",
        "logical_x:",
        "logical_width:",
        "subpixel_orientation:",
        "make:",
    )
    geometry = [
        line.strip()
        for line in result.stdout.splitlines()
        if line.strip().startswith(keys)
    ]
    if not geometry:
        raise RuntimeError("The compositor did not expose display geometry")
    return zlib.crc32("\n".join(geometry).encode())


def monitors():
    if wayland:
        return [
            dict(
                id="portal",
                name="Choose a display on this computer",
                width=0,
                height=0,
                revision=wayland_revision(),
            )
        ]
    rotation = []
    if xdisplay.has_extension("RANDR"):
        resources = xdisplay.screen().root.xrandr_get_screen_resources_current()
        for crtc in resources.crtcs:
            info = xdisplay.xrandr_get_crtc_info(crtc, resources.config_timestamp)
            rotation.append(
                (crtc, info.x, info.y, info.width, info.height, info.rotation)
            )
    rows = []
    for index in range(display.get_n_monitors()):
        monitor = display.get_monitor(index)
        geometry = monitor.get_geometry()
        scale = monitor.get_scale_factor()
        x, y, w, h = [
            int(i * scale)
            for i in (geometry.x, geometry.y, geometry.width, geometry.height)
        ]
        rev = zlib.crc32(f"{index}:{x}:{y}:{w}:{h}:{scale}:{rotation}".encode())
        rows.append(
            dict(
                id=str(index),
                name=monitor.get_model() or f"Display {index + 1}",
                x=x,
                y=y,
                width=w,
                height=h,
                revision=rev,
            )
        )
    return rows


active = unlocked()
try:
    initial_displays = monitors() if active else []
except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
    unavailable(
        str(error)
        if isinstance(error, RuntimeError)
        else "Could not determine display geometry"
    )
if sys.argv[1:2] == ["probe"]:
    emit(
        dict(
            available=active,
            control=active and can_input,
            reason=""
            if active
            else "An unlocked graphical session with lock detection is required",
            displays=initial_displays,
        )
    )
    sys.exit(0)
if len(sys.argv) not in (7, 8) or sys.argv[1] != "stream" or not active:
    unavailable("The user session or display is unavailable")
selected = next((row for row in initial_displays if row["id"] == sys.argv[2]), None)
if selected is None:
    unavailable("Display disconnected")
if str(selected["revision"]) != sys.argv[6]:
    unavailable("Display geometry changed before sharing")
controller = sys.argv[5][:96]
session_path = None
stream_id = 0
stream_width, stream_height = selected["width"], selected["height"]
authorized = False
held_keys = set()
held_buttons = set()
stopped = False
current_portal = None
control_epoch = 0
encoded_size = (0, 0)
pipeline = None


class PickerDenied(RuntimeError):
    """The local chooser declined devices without authorizing remote input."""


def portal_request(iface, method, *args, **extra):
    token = "g" + uuid.uuid4().hex
    name = bus.get_unique_name()[1:].replace(".", "_")
    path = ROOT + "/request/" + name + "/" + token
    loop = GLib.MainLoop()
    result = []

    def response(code, details):
        result.extend([int(code), details])
        loop.quit()

    hook = bus.add_signal_receiver(
        response,
        signal_name="Response",
        dbus_interface="org.freedesktop.portal.Request",
        path=path,
    )

    def timeout():
        loop.quit()
        return False

    timer = GLib.timeout_add_seconds(75, timeout)
    try:
        options = dbus.Dictionary(dict(handle_token=token, **extra), signature="sv")
        actual = str(getattr(dbus.Interface(portal, iface), method)(*args, options))
        if actual != path:
            raise RuntimeError("Unexpected portal request path")
        loop.run()
        if not result:
            dbus.Interface(
                bus.get_object(PORTAL, path), "org.freedesktop.portal.Request"
            ).Close(timeout=1)
            raise PickerDenied("The local screen chooser timed out")
        if result[0] == 1:
            raise PickerDenied("The target owner canceled the screen chooser")
        if result[0] != 0:
            raise RuntimeError("The desktop portal failed to open the selected screen")
        return result[1]
    finally:
        hook.remove()
        if GLib.MainContext.default().find_source_by_id(timer):
            GLib.source_remove(timer)


def close_portal(lease):
    if lease is None:
        return
    try:
        dbus.Interface(
            bus.get_object(PORTAL, lease["path"]), "org.freedesktop.portal.Session"
        ).Close(timeout=1)
    except dbus.DBusException:
        pass
    if "fd" in lease:
        os.close(lease["fd"])


def portal_logical_size(properties):
    # Some ScreenCast backends report the unrotated hardware mode for a
    # monitor even though PipeWire carries its upright desktop. GDK exposes
    # the compositor's logical rectangle, also used for absolute input.
    position = properties.get("position")
    count = display.get_n_monitors()
    for index in range(count):
        geometry = display.get_monitor(index).get_geometry()
        if (position is None and count == 1) or position == (geometry.x, geometry.y):
            return (geometry.width, geometry.height)
    return tuple(map(int, properties["size"]))


def open_portal(with_input):
    iface = REMOTE if with_input else CAST
    result = portal_request(
        iface, "CreateSession", session_handle_token="s" + uuid.uuid4().hex
    )
    path = dbus.ObjectPath(result["session_handle"])
    lease = {"path": path}
    try:
        if with_input:
            portal_request(REMOTE, "SelectDevices", path, types=dbus.UInt32(3))
        options = dict(types=dbus.UInt32(1), multiple=dbus.Boolean(False))
        modes = int(dbus.Interface(portal, PROPS).Get(CAST, "AvailableCursorModes"))
        if modes & 2:
            options["cursor_mode"] = dbus.UInt32(2)
        portal_request(CAST, "SelectSources", path, **options)
        result = portal_request(iface, "Start", path, "")
        node, props = result["streams"][0]
        if "size" not in props:
            raise RuntimeError("The portal did not report display geometry")
        if with_input and int(result.get("devices", 0)) & 3 != 3:
            raise PickerDenied(
                "The target did not grant both pointer and keyboard input"
            )
        lease.update(
            node=node,
            size=portal_logical_size(props),
            position=props.get("position"),
            mapping=props.get("mapping_id"),
            control=with_input,
        )
        lease["fd"] = (
            dbus.Interface(portal, CAST)
            .OpenPipeWireRemote(path, dbus.Dictionary({}, signature="sv"))
            .take()
        )
        bus.add_signal_receiver(
            lambda *args: (
                stop("Portal sharing stopped") if lease is current_portal else None
            ),
            signal_name="Closed",
            dbus_interface="org.freedesktop.portal.Session",
            path=str(path),
        )
        return lease
    except Exception:
        close_portal(lease)
        raise


def portal_source(lease):
    src = Gst.ElementFactory.make("pipewiresrc")
    src.set_property("fd", os.dup(lease["fd"]))
    src.set_property("path", str(lease["node"]))
    return src


def source():
    global current_portal, session_path, stream_id, stream_width, stream_height
    if wayland:
        current_portal = open_portal(False)
        session_path = current_portal["path"]
        stream_id = current_portal["node"]
        stream_width, stream_height = current_portal["size"]
        return portal_source(current_portal)
    src = Gst.ElementFactory.make("ximagesrc")
    for key, val in (
        ("startx", selected["x"]),
        ("starty", selected["y"]),
        ("endx", selected["x"] + stream_width - 1),
        ("endy", selected["y"] + stream_height - 1),
        ("use-damage", False),
        ("show-pointer", True),
    ):
        src.set_property(key, val)
    return src


def make_pipeline(src, w, h):
    p = Gst.Pipeline.new(None)
    pacing = "imagefreeze is-live=true allow-replace=true" if wayland else "videorate"
    sink = Gst.parse_bin_from_description(
        "videoscale ! videoconvert ! video/x-raw,format=BGRA,width=%d,height=%d ! %s ! video/x-raw,framerate=15/1 ! fdsink fd=3 sync=false"
        % (w, h, pacing),
        True,
    )
    p.add(src)
    p.add(sink)
    if not src.link(sink):
        raise RuntimeError("Capture pipeline failed to link")
    message_bus = p.get_bus()
    message_bus.add_signal_watch()
    message_bus.connect(
        "message::error",
        lambda *_: stop("Linux screen capture failed") if p is pipeline else None,
    )
    message_bus.connect(
        "message::eos",
        lambda *_: stop("Display stream ended") if p is pipeline else None,
    )
    return p


def upgrade_portal(epoch):
    global current_portal, session_path, stream_id, pipeline
    if current_portal["control"]:
        return
    old = current_portal
    old_pipeline = pipeline
    # Keep the selected view available when the user declines an input upgrade.
    # Show only black frames while the local permission chooser is visible.
    old_pipeline.set_state(Gst.State.PAUSED)
    old_pipeline.get_state(2 * Gst.SECOND)
    black = Gst.ElementFactory.make("videotestsrc")
    black.set_property("pattern", 2)
    black.set_property("is-live", True)
    blank = make_pipeline(black, *encoded_size)
    blank.set_state(Gst.State.PLAYING)
    new = None
    replacement = None
    try:
        new = open_portal(True)
        if selected not in monitors():
            stop("Display geometry changed")
        if old["mapping"] is not None and new["mapping"] is not None:
            same_monitor = old["mapping"] == new["mapping"]
        elif old["position"] is not None and new["position"] is not None:
            same_monitor = old["position"] == new["position"]
        else:
            same_monitor = display.get_n_monitors() == 1
        if old["size"] != new["size"] or not same_monitor:
            raise PickerDenied("Select the same display to enable input")
        if epoch != control_epoch or not unlocked():
            raise RuntimeError("Control request ended")
        replacement = make_pipeline(portal_source(new), *encoded_size)
        blank.set_state(Gst.State.NULL)
        if replacement.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("The input portal could not share this display")
        current_portal = new
        pipeline = replacement
        session_path = new["path"]
        stream_id = new["node"]
    except Exception:
        if replacement:
            replacement.set_state(Gst.State.NULL)
        close_portal(new)
        blank.set_state(Gst.State.NULL)
        if (
            not unlocked()
            or old_pipeline.set_state(Gst.State.PLAYING)
            == Gst.StateChangeReturn.FAILURE
        ):
            stop("The approved display is no longer available")
        raise
    old_pipeline.set_state(Gst.State.NULL)
    close_portal(old)


codes = {
    **dict(
        zip(
            [
                "Escape",
                *["Digit" + str(i) for i in range(1, 10)],
                "Digit0",
                "Minus",
                "Equal",
                "Backspace",
                "Tab",
            ],
            range(1, 16),
        )
    ),
    **dict(zip(["Key" + k for k in "QWERTYUIOP"], range(16, 26))),
    "BracketLeft": 26,
    "BracketRight": 27,
    "Enter": 28,
    "ControlLeft": 29,
    **dict(zip(["Key" + k for k in "ASDFGHJKL"], range(30, 39))),
    "Semicolon": 39,
    "Quote": 40,
    "Backquote": 41,
    "ShiftLeft": 42,
    "Backslash": 43,
    **dict(zip(["Key" + k for k in "ZXCVBNM"], range(44, 51))),
    "Comma": 51,
    "Period": 52,
    "Slash": 53,
    "ShiftRight": 54,
    "AltLeft": 56,
    "Space": 57,
    **{"F" + str(i): 58 + i for i in range(1, 11)},
    "F11": 87,
    "F12": 88,
    "ControlRight": 97,
    "AltRight": 100,
    "Home": 102,
    "ArrowUp": 103,
    "PageUp": 104,
    "ArrowLeft": 105,
    "ArrowRight": 106,
    "End": 107,
    "ArrowDown": 108,
    "PageDown": 109,
    "Delete": 111,
    "MetaLeft": 125,
    "MetaRight": 126,
}
empty = dbus.Dictionary({}, signature="sv")


def native_key(code, down):
    if wayland:
        dbus.Interface(portal, REMOTE).NotifyKeyboardKeycode(
            session_path, empty, dbus.Int32(code), dbus.UInt32(int(down))
        )
    else:
        xtest.fake_input(xdisplay, X.KeyPress if down else X.KeyRelease, code + 8)
        xdisplay.sync()
    (held_keys.add if down else held_keys.discard)(code)


def native_button(button, down):
    if wayland:
        # Linux BTN_LEFT, BTN_MIDDLE, BTN_RIGHT in DOM numbering.
        dbus.Interface(portal, REMOTE).NotifyPointerButton(
            session_path,
            empty,
            dbus.Int32([272, 274, 273][button]),
            dbus.UInt32(int(down)),
        )
    else:
        xtest.fake_input(
            xdisplay, X.ButtonPress if down else X.ButtonRelease, button + 1
        )
        xdisplay.sync()
    (held_buttons.add if down else held_buttons.discard)(button)


def reset():
    for key in tuple(held_keys):
        native_key(key, False)
    for button in tuple(held_buttons):
        native_button(button, False)


def stop(reason):
    global stopped
    if stopped:
        return
    stopped = True
    try:
        reset()
    except Exception:
        pass
    if session_path:
        try:
            dbus.Interface(
                bus.get_object(PORTAL, session_path), "org.freedesktop.portal.Session"
            ).Close(timeout=1)
        except Exception:
            pass
    emit(dict(type="ended", reason=reason))
    # This helper exclusively owns its pipelines and DBus connection. Closing
    # the latter releases portal grants, even while its chooser is pending.
    os._exit(0)


def type_character(character):
    # A keysym alone maps to a physical evdev key on some compositors, which
    # loses its shift level. Resolve the current seat keymap, including AltGr.
    sym = Gdk.unicode_to_keyval(ord(character))
    entries = Gdk.Keymap.get_for_display(display).get_entries_for_keyval(sym).keys
    candidates = [
        entry
        for entry in entries
        if entry.group == 0 and 0 <= entry.level <= 3 and entry.keycode >= 8
    ]
    if candidates:
        entry = min(candidates, key=lambda e: (e.keycode >= 128, e.level))
        modifiers = []
        if entry.level & 1 and 42 not in held_keys and 54 not in held_keys:
            modifiers.append(42)
        if entry.level & 2 and 100 not in held_keys:
            modifiers.append(100)
        for code in modifiers:
            native_key(code, True)
        native_key(entry.keycode - 8, True)
        native_key(entry.keycode - 8, False)
        for code in reversed(modifiers):
            native_key(code, False)
        return
    # The standard Linux Unicode input sequence enters a committed codepoint
    # in input methods such as GTK's simple context, without reading clipboard.
    for code in [29, 42, 22]:
        native_key(code, True)
    for code in [22, 42, 29]:
        native_key(code, False)
    for digit in format(ord(character), "x"):
        code = codes["Digit" + digit if digit.isdigit() else "Key" + digit.upper()]
        native_key(code, True)
        native_key(code, False)
    native_key(28, True)
    native_key(28, False)


def apply(message):
    global authorized, control_epoch
    k = message.get("type")
    try:
        if k == "close":
            stop("Session ended")
        if k == "control":
            reset()
            authorized = False
            control_epoch += 1
            epoch = control_epoch
            if message.get("enabled") and can_input and unlocked():
                try:
                    if wayland:
                        upgrade_portal(epoch)
                    authorized = epoch == control_epoch and unlocked()
                except (dbus.DBusException, RuntimeError, ValueError) as error:
                    reason = (
                        str(error)
                        if isinstance(error, RuntimeError)
                        else "The compositor denied desktop input"
                    )
                    reply = dict(id=message.get("id"), ok=False, error=reason)
                    if (
                        isinstance(error, PickerDenied)
                        and unlocked()
                        and current_portal is not None
                    ):
                        reply["code"] = "INPUT_DENIED"
                    emit(reply)
                    return False
            emit(
                dict(id=message.get("id"), ok=authorized or not message.get("enabled"))
            )
            return False
        if k == "reset":
            reset()
            return False
        if not authorized or not unlocked():
            return False
        if k in ("move", "button"):
            x = min(1, max(0, message["x"])) * (stream_width - 1)
            y = min(1, max(0, message["y"])) * (stream_height - 1)
            if wayland:
                dbus.Interface(portal, REMOTE).NotifyPointerMotionAbsolute(
                    session_path, empty, dbus.UInt32(stream_id), x, y
                )
            else:
                xtest.fake_input(
                    xdisplay,
                    X.MotionNotify,
                    x=selected["x"] + int(x),
                    y=selected["y"] + int(y),
                )
                xdisplay.sync()
        if k == "button":
            native_button(message["button"], message["down"])
        elif k == "key" and message["code"] in codes:
            native_key(codes[message["code"]], message["down"])
        elif k == "text":
            if wayland:
                for character in message["text"]:
                    type_character(character)
            else:
                subprocess.run(
                    ["xdotool", "type", "--clearmodifiers", "--file", "-"],
                    input=message["text"].encode(),
                    check=True,
                    timeout=4,
                )
        elif k == "wheel":
            if wayland:
                dbus.Interface(portal, REMOTE).NotifyPointerAxis(
                    session_path, empty, float(message["dx"]), float(message["dy"])
                )
            else:
                for delta, lower, higher in [
                    (message["dy"], 4, 5),
                    (message["dx"], 6, 7),
                ]:
                    for _ in range(min(8, math.ceil(abs(delta) / 55))):
                        code = lower if delta < 0 else higher
                        xtest.fake_input(xdisplay, X.ButtonPress, code)
                        xtest.fake_input(xdisplay, X.ButtonRelease, code)
                xdisplay.sync()
    except Exception:
        authorized = False
        try:
            reset()
        except Exception:
            pass
        emit(
            dict(
                type="control-revoked",
                reason="The desktop input capability was revoked",
            )
        )
    return False


def read_commands():
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            break
        GLib.idle_add(apply, msg)
    GLib.idle_add(stop, "Coordinator disconnected")


last_geometry_check = 0.0


def periodic_check():
    global last_geometry_check
    if not unlocked():
        stop("Desktop locked or display changed")
    if time.monotonic() - last_geometry_check >= 1:
        last_geometry_check = time.monotonic()
        try:
            if selected not in monitors():
                stop("Display geometry changed")
        except Exception:
            stop("Display geometry is unavailable")
    return True


def run():
    global pipeline, encoded_size
    Gdk.Screen.get_default().connect(
        "monitors-changed", lambda *_: stop("Display layout changed")
    )
    window = Gtk.Window(title="Godbot · Sharing")
    window.set_keep_above(True)
    window.set_resizable(False)
    window.move(10, 10)
    window.connect("delete-event", lambda *_: stop("Stopped on target"))
    row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    row.set_border_width(10)
    row.add(Gtk.Label(label="Sharing with " + controller))
    button = Gtk.Button(label="Stop sharing")
    button.connect("clicked", lambda *_: stop("Stopped on target"))
    row.add(button)
    window.add(row)
    window.show_all()
    threading.Thread(target=read_commands, daemon=True).start()
    src = source()
    if not 0 < stream_width <= 32768 or not 0 < stream_height <= 32768:
        raise RuntimeError("Invalid display size")
    # The local portal picker can stay open while the monitor layout changes.
    if selected not in monitors():
        stop("Display geometry changed before sharing")
    low = sys.argv[7:8] == ["low"]
    factor = min(
        1, (960 if low else 1280) / stream_width, (540 if low else 960) / stream_height
    )
    w = max(2, int(stream_width * factor / 2) * 2)
    h = max(2, int(stream_height * factor / 2) * 2)
    emit(dict(type="format", width=w, height=h))
    encoded_size = (w, h)
    pipeline = make_pipeline(src, w, h)
    if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
        raise RuntimeError("Screen capture failed to start")
    GLib.timeout_add(350, periodic_check)
    emit(dict(type="ready", control=bool(can_input), revision=selected["revision"]))
    Gtk.main()


try:
    run()
except Exception as error:
    stop(
        str(error)
        if isinstance(error, RuntimeError)
        else "Could not open the Linux screen sharing session"
    )
