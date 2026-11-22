import AppKit
import Carbon
import CoreGraphics
import CoreMedia
import Darwin
import ScreenCaptureKit

typealias Object = [String: Any]
let outputLock = NSLock()
func send(_ object: Object) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  outputLock.lock()
  defer { outputLock.unlock() }
  FileHandle.standardOutput.write(data + Data([10]))
}

func consoleUnlocked() -> Bool {
  guard let session = CGSessionCopyCurrentDictionary() as? Object,
    session[kCGSessionOnConsoleKey as String] as? Bool == true,
    session[kCGSessionUserIDKey as String] as? UInt32 == getuid()
  else { return false }
  return session["CGSSessionScreenIsLocked"] as? Bool != true
}

func geometryRevision(_ id: CGDirectDisplayID, _ bounds: CGRect, _ mode: CGDisplayMode) -> Int {
  let values = [
    Int(bounds.origin.x), Int(bounds.origin.y), Int(bounds.width), Int(bounds.height),
    mode.pixelWidth, mode.pixelHeight, Int(CGDisplayRotation(id)),
  ]
  return Int(
    values.reduce(UInt32(2_166_136_261)) {
      ($0 ^ UInt32(truncatingIfNeeded: $1)) &* 16_777_619
    })
}

func screens() -> [Object] {
  NSScreen.screens.compactMap { screen in
    guard
      let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
    else { return nil }
    let id = CGDirectDisplayID(number.uint32Value)
    let bounds = CGDisplayBounds(id)
    guard let mode = CGDisplayCopyDisplayMode(id), bounds.width > 0, bounds.height > 0 else {
      return nil
    }
    return [
      "id": String(id), "name": screen.localizedName, "width": mode.pixelWidth,
      "height": mode.pixelHeight, "revision": geometryRevision(id, bounds, mode),
    ]
  }
}

let keys: [String: CGKeyCode] = [
  "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8,
  "KeyV": 9, "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
  "Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24,
  "Digit9": 25, "Digit7": 26, "Minus": 27, "Digit8": 28, "Digit0": 29, "BracketRight": 30,
  "KeyO": 31,
  "KeyU": 32, "BracketLeft": 33, "KeyI": 34, "KeyP": 35, "Enter": 36, "KeyL": 37, "KeyJ": 38,
  "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44, "KeyN": 45,
  "KeyM": 46, "Period": 47, "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51, "Escape": 53,
  "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "AltLeft": 58, "ControlLeft": 59,
  "ShiftRight": 60,
  "AltRight": 61, "ControlRight": 62, "F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101,
  "F11": 103, "F10": 109, "F12": 111, "Home": 115, "PageUp": 116, "Delete": 117, "F4": 118,
  "End": 119,
  "F2": 120, "PageDown": 121, "F1": 122, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125,
  "ArrowUp": 126,
]

final class Session: NSObject, SCStreamOutput, SCStreamDelegate {
  let displayID: CGDirectDisplayID
  let revision: Int
  let controller: String
  let bounds: CGRect
  let width: Int
  let height: Int
  var stream: SCStream?
  var item: NSStatusItem?
  var control = false
  var heldKeys: Set<CGKeyCode> = []
  var heldButtons: Set<Int> = []
  var lastPoint: CGPoint
  var ended = false
  private let video = FileHandle(fileDescriptor: 3, closeOnDealloc: false)
  private let captureQueue = DispatchQueue(label: "io.godbot.capture")
  private var newestFrame: Data?
  private var pacing: DispatchSourceTimer?

  init(id: CGDirectDisplayID, width: Int, height: Int, controller: String, revision: Int) {
    self.displayID = id
    self.revision = revision
    self.width = width
    self.height = height
    self.controller = controller
    self.bounds = CGDisplayBounds(id)
    self.lastPoint = CGPoint(x: bounds.midX, y: bounds.midY)
  }

  private func geometryMatches() -> Bool {
    let currentBounds = CGDisplayBounds(displayID)
    guard CGDisplayIsActive(displayID) != 0, currentBounds == bounds,
      let mode = CGDisplayCopyDisplayMode(displayID)
    else { return false }
    return geometryRevision(displayID, currentBounds, mode) == revision
  }

  @MainActor func start() async {
    do {
      guard consoleUnlocked(), CGPreflightScreenCaptureAccess() else {
        stop("Screen Recording permission or an unlocked graphical session is required")
        return
      }
      guard geometryMatches() else {
        stop("Display geometry changed before sharing")
        return
      }
      let content = try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: true)
      guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
        stop("Display disconnected")
        return
      }
      let filter = SCContentFilter(display: display, excludingWindows: [])
      let config = SCStreamConfiguration()
      config.width = width
      config.height = height
      config.pixelFormat = kCVPixelFormatType_32BGRA
      config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
      config.queueDepth = 3
      config.showsCursor = true
      config.capturesAudio = false
      let capturing = SCStream(filter: filter, configuration: config, delegate: self)
      stream = capturing
      try capturing.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
      let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
      status.button?.title = "▣ Godbot · Sharing"
      let menu = NSMenu()
      menu.addItem(withTitle: "Sharing with " + controller, action: nil, keyEquivalent: "")
      let button = menu.addItem(
        withTitle: "Stop sharing", action: #selector(stopLocally), keyEquivalent: "")
      button.target = self
      status.menu = menu
      item = status
      for name in [
        NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.willSleepNotification,
        NSWorkspace.screensDidSleepNotification,
      ] {
        NSWorkspace.shared.notificationCenter.addObserver(
          self, selector: #selector(sessionChanged), name: name, object: nil)
      }
      DistributedNotificationCenter.default().addObserver(
        self, selector: #selector(sessionChanged), name: .init("com.apple.screenIsLocked"),
        object: nil)
      DistributedNotificationCenter.default().addObserver(
        self, selector: #selector(sessionChanged),
        name: .init("io.github.renjiegod.godbot.computerhost.setup"), object: nil)
      NotificationCenter.default.addObserver(
        self, selector: #selector(sessionChanged),
        name: NSApplication.didChangeScreenParametersNotification, object: nil)
      let timer = DispatchSource.makeTimerSource(queue: captureQueue)
      timer.schedule(deadline: .now(), repeating: .milliseconds(67))
      timer.setEventHandler { [weak self] in
        guard let self = self, let frame = self.newestFrame else { return }
        do { try self.video.write(contentsOf: frame) } catch {
          DispatchQueue.main.async { self.stop("Capture reader closed") }
        }
      }
      pacing = timer
      timer.resume()
      try await capturing.startCapture()
      guard geometryMatches() else {
        stop("Display geometry changed before sharing")
        return
      }
      send(["type": "ready", "revision": revision])
      armPermissionCheck()
    } catch { stop("Screen capture could not start") }
  }

  func stream(
    _ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType
  ) {
    guard type == .screen, sample.isValid,
      let records = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let record = records.first, let status = record[.status] as? Int
    else { return }
    if status == SCFrameStatus.blank.rawValue || status == SCFrameStatus.suspended.rawValue
      || status == SCFrameStatus.stopped.rawValue
    {
      newestFrame = nil
      DispatchQueue.main.async { self.stop("Display sharing was suspended") }
      return
    }
    guard status == SCFrameStatus.complete.rawValue, let pixel = sample.imageBuffer else { return }
    CVPixelBufferLockBaseAddress(pixel, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixel, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixel), CVPixelBufferGetWidth(pixel) == width,
      CVPixelBufferGetHeight(pixel) == height
    else { return }
    let stride = CVPixelBufferGetBytesPerRow(pixel)
    var data = Data(capacity: width * height * 4)
    if stride == width * 4 {
      data.append(base.assumingMemoryBound(to: UInt8.self), count: stride * height)
    } else {
      for row in 0..<height {
        data.append(
          base.advanced(by: row * stride).assumingMemoryBound(to: UInt8.self), count: width * 4)
      }
    }
    newestFrame = data
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    DispatchQueue.main.async { self.stop("Screen capture stopped") }
  }
  private func armPermissionCheck() {
    let timer = Timer(
      timeInterval: 0.5, target: self, selector: #selector(checkPermissions), userInfo: nil,
      repeats: true)
    RunLoop.main.add(timer, forMode: .common)
  }
  @objc func checkPermissions() {
    if !consoleUnlocked() || !CGPreflightScreenCaptureAccess() || IsSecureEventInputEnabled() {
      stop("Sharing ended because the desktop is locked, protected, or unavailable")
    } else if control && !AXIsProcessTrusted() {
      revokeInput()
    }
  }
  func revokeInput() {
    guard control else { return }
    control = false
    release()
    send(["type": "control-revoked", "reason": "Accessibility permission was revoked"])
  }
  @objc func sessionChanged() { stop("Graphical session changed") }
  @objc func stopLocally() { stop("Stopped on target") }
  func stop(_ reason: String) {
    guard !ended else { return }
    ended = true
    release()
    send(["type": "ended", "reason": reason])
    exit(0)
  }
  func flags() -> CGEventFlags {
    var f: CGEventFlags = []
    if !heldKeys.isDisjoint(with: [56, 60]) { f.insert(.maskShift) }
    if !heldKeys.isDisjoint(with: [58, 61]) { f.insert(.maskAlternate) }
    if !heldKeys.isDisjoint(with: [59, 62]) { f.insert(.maskControl) }
    if !heldKeys.isDisjoint(with: [54, 55]) { f.insert(.maskCommand) }
    return f
  }
  func key(_ code: CGKeyCode, _ down: Bool) {
    if down { heldKeys.insert(code) } else { heldKeys.remove(code) }
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    event?.flags = flags()
    event?.post(tap: .cghidEventTap)
  }
  func mouse(_ button: Int, _ down: Bool) {
    let buttons: [CGMouseButton] = [.left, .center, .right]
    let starts: [CGEventType] = [.leftMouseDown, .otherMouseDown, .rightMouseDown]
    let ends: [CGEventType] = [.leftMouseUp, .otherMouseUp, .rightMouseUp]
    guard (0...2).contains(button) else { return }
    let event = CGEvent(
      mouseEventSource: nil, mouseType: down ? starts[button] : ends[button],
      mouseCursorPosition: lastPoint, mouseButton: buttons[button])
    event?.flags = flags()
    event?.post(tap: .cghidEventTap)
    if down { heldButtons.insert(button) } else { heldButtons.remove(button) }
  }
  func release() {
    for code in Array(heldKeys) { key(code, false) }
    for b in Array(heldButtons) { mouse(b, false) }
  }
  func command(_ m: Object) {
    guard let type = m["type"] as? String else { return }
    if type == "close" {
      stop("Session closed")
      return
    }
    if type == "control" {
      release()
      control = m["enabled"] as? Bool == true && consoleUnlocked() && AXIsProcessTrusted()
      if m["enabled"] as? Bool == true && !control && consoleUnlocked()
        && CGPreflightScreenCaptureAccess()
      {
        send([
          "id": m["id"] ?? 0, "ok": false, "code": "INPUT_DENIED",
          "error": "Allow Accessibility to control this Mac",
        ])
      } else {
        send(["id": m["id"] ?? 0, "ok": m["enabled"] as? Bool != true || control])
      }
      return
    }
    if type == "reset" {
      release()
      return
    }
    if control && !AXIsProcessTrusted() {
      revokeInput()
      return
    }
    guard control, consoleUnlocked(), !IsSecureEventInputEnabled() else { return }
    if let x = m["x"] as? Double, let y = m["y"] as? Double {
      lastPoint = CGPoint(
        x: bounds.origin.x + min(1, max(0, x)) * max(0, bounds.width - 1),
        y: bounds.origin.y + min(1, max(0, y)) * max(0, bounds.height - 1))
    }
    switch type {
    case "move":
      let b =
        heldButtons.contains(0) ? 0 : heldButtons.contains(2) ? 2 : heldButtons.contains(1) ? 1 : -1
      let kind: CGEventType =
        b == 0
        ? .leftMouseDragged
        : b == 2 ? .rightMouseDragged : b == 1 ? .otherMouseDragged : .mouseMoved
      let event = CGEvent(
        mouseEventSource: nil, mouseType: kind, mouseCursorPosition: lastPoint,
        mouseButton: b == 2 ? .right : b == 1 ? .center : .left)
      event?.flags = flags()
      event?.post(tap: .cghidEventTap)
    case "button":
      if let b = m["button"] as? Int, let down = m["down"] as? Bool { mouse(b, down) }
    case "wheel":
      let dx = Int32(clamping: Int(m["dx"] as? Double ?? 0))
      let dy = Int32(clamping: Int(m["dy"] as? Double ?? 0))
      CGEvent(
        scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx,
        wheel3: 0)?.post(tap: .cghidEventTap)
    case "key":
      if let code = m["code"] as? String, let keyCode = keys[code], let down = m["down"] as? Bool {
        key(keyCode, down)
      }
    case "text":
      if let text = m["text"] as? String {
        for character in text {
          let units = Array(String(character).utf16)
          for down in [true, false] {
            let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
            e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            e?.post(tap: .cghidEventTap)
          }
        }
      }
    default: break
    }
  }
}

signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
if CommandLine.arguments.count == 1 || CommandLine.arguments.dropFirst().first == "permissions" {
  // End sharing before presenting local-only privacy controls.
  DistributedNotificationCenter.default().postNotificationName(
    .init("io.github.renjiegod.godbot.computerhost.setup"), object: nil, userInfo: nil,
    deliverImmediately: true)
  app.setActivationPolicy(.regular)
  app.activate(ignoringOtherApps: true)
  let panel = NSAlert()
  panel.messageText = "Godbot Computer Host"
  panel.informativeText =
    "Screen Recording: " + (CGPreflightScreenCaptureAccess() ? "allowed" : "permission required")
    + "\nPointer and keyboard: "
    + (AXIsProcessTrusted() ? "allowed" : "Accessibility permission required")
    + "\n\nSet permissions for this app in System Settings. Pair controllers separately with the Godbot Computer Host."
  panel.addButton(withTitle: "Done")
  panel.addButton(withTitle: "Screen Recording…")
  panel.addButton(withTitle: "Accessibility…")
  panel.addButton(withTitle: "Manage paired controllers…")
  let choice = panel.runModal()
  if choice == .alertSecondButtonReturn {
    _ = CGRequestScreenCaptureAccess()
    NSWorkspace.shared.open(
      URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
  } else if choice == .alertThirdButtonReturn {
    _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    NSWorkspace.shared.open(
      URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
  } else if choice.rawValue == NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + 3 {
    let launcher = Process()
    launcher.executableURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
      ".local/bin/godbot-computer")
    launcher.arguments = ["manage"]
    do { try launcher.run() } catch {
      let errorPanel = NSAlert()
      errorPanel.messageText = "Install the Godbot Computer Host CLI first"
      errorPanel.informativeText =
        "The local controller manager opens from ~/.local/bin/godbot-computer."
      errorPanel.runModal()
    }
  }
  exit(0)
}
if CommandLine.arguments.count == 2 {
  switch CommandLine.arguments[1] {
  case "probe":
    let visible = consoleUnlocked()
    let capture = CGPreflightScreenCaptureAccess()
    send([
      "available": visible && capture, "control": visible && AXIsProcessTrusted(),
      "reason": !visible
        ? "No unlocked graphical session"
        : !capture ? "Allow Screen Recording for Godbot Computer Host" : "",
      "displays": visible && capture ? screens() : [],
    ])
    exit(0)
  default: break
  }
}
guard CommandLine.arguments.count == 7, CommandLine.arguments[1] == "stream",
  let id = UInt32(CommandLine.arguments[2]), let revision = UInt32(CommandLine.arguments[6]),
  let width = Int(CommandLine.arguments[3]), let height = Int(CommandLine.arguments[4]), width > 0,
  height > 0, width <= 1920, height <= 1920
else { exit(2) }
let session = Session(
  id: id, width: width, height: height, controller: String(CommandLine.arguments[5].prefix(96)),
  revision: Int(revision))
DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
      let m = try? JSONSerialization.jsonObject(with: data) as? Object
    else { continue }
    DispatchQueue.main.async { session.command(m) }
  }
  DispatchQueue.main.async { session.stop("Coordinator disconnected") }
}
Task { @MainActor in await session.start() }
app.run()
