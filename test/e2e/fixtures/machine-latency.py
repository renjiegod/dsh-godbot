"""A color-changing click target on the isolated Linux validation display."""
import os
from pathlib import Path

import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gdk, GLib, Gtk

root = Path(os.environ['GODBOT_DESKTOP_TEST_DIR'])
window = Gtk.Window(type=Gtk.WindowType.POPUP)
window.set_default_size(250, 135)
window.move(950, 480)
area = Gtk.EventBox()
area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=8)
label = Gtk.Label(label="Godbot desktop validation")
bar = Gtk.ProgressBar()
box.pack_start(label,False,False,8)
box.pack_end(bar,False,False,6)
area.add(box)
window.add(area)
state = {'blue': False, 'tick': 0}

def paint():
    rgba = Gdk.RGBA()
    rgba.parse('#1a45ec' if state['blue'] else '#21b84a')
    area.override_background_color(Gtk.StateFlags.NORMAL, rgba)

def toggle(_widget, event):
    if event.type != Gdk.EventType.BUTTON_PRESS:
        return False
    state['blue'] = not state['blue']
    paint()
    return True

def tick():
    state['tick'] += 1
    bar.set_fraction((state['tick'] % 60)/60)
    return True

def report():
    _, x, y = window.get_window().get_origin()
    (root / 'latency-point').write_text(f"{x+125} {y+72}")
    return False

paint()
area.connect('button-press-event', toggle)
window.show_all()
GLib.timeout_add(66, tick)
GLib.timeout_add(200, report)
Gtk.main()
