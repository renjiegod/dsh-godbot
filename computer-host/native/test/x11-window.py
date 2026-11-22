#!/usr/bin/python3
"""A real GTK target on the disposable validation X display."""

import os
from pathlib import Path
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk

work = Path(os.environ["GODBOT_DESKTOP_TEST_DIR"])
window = Gtk.Window(title="Godbot E2E target")
window.set_decorated(False)
window.set_default_size(540, 260)
window.move(250, 200)
entry = Gtk.Entry()
entry.set_placeholder_text("Remote input receipt")
entry.connect(
    "changed", lambda widget: (work / "receipt").write_text(widget.get_text())
)
window.add(entry)
window.show_all()
if os.getenv("GODBOT_DESKTOP_TEST_WAYLAND"):
    window.fullscreen()


def ready():
    _, x, y = window.get_window().get_origin()
    (work / "point").write_text("%s %s" % (x + 240, y + 124))
    return False


GLib.timeout_add(300, ready)
Gtk.main()
