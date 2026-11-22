// The graphical runtime is explicitly installed under the current user. The
// headless package can therefore run without any capture or codec libraries.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeRuntimePath } from './desktop.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const dest = nativeRuntimePath()
const previous = join(dest, 'previous')
const mac = process.platform === 'darwin'
const capture = mac ? 'Godbot Computer Host.app' : 'godbot-screen'
const files = ['godbot-desktop-rtc', capture]
const run = (name, args, cwd = here) => execFileSync(name, args, { cwd, stdio: 'inherit' })
const installed = []
const saved = []

function signingIdentity() {
  if (process.env.GODBOT_MAC_SIGNING_IDENTITY) return process.env.GODBOT_MAC_SIGNING_IDENTITY
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  })
  const dev = [...identities.matchAll(/\) ([0-9A-Fa-f]{40}) "Apple Development:/g)]
  if (dev.length === 1) return dev[0][1]
  if (dev.length > 1)
    throw Error('Set GODBOT_MAC_SIGNING_IDENTITY to the intended Apple Development identity')
  console.error('Local ad-hoc build. macOS may request permissions again after a rebuild.')
  return '-'
}
function build(stage) {
  run('go', ['build', '-trimpath', '-o', join(stage, files[0]), '.'], join(here, 'rtc'))
  if (mac) {
    const app = join(stage, capture),
      contents = join(app, 'Contents')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    run('swiftc', [
      '-O',
      '-swift-version',
      '5',
      join(here, 'macos', 'Screen.swift'),
      '-framework',
      'Cocoa',
      '-framework',
      'ScreenCaptureKit',
      '-framework',
      'Carbon',
      '-o',
      join(contents, 'MacOS', 'godbot-screen'),
    ])
    writeFileSync(
      join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>godbot-screen</string><key>CFBundleIdentifier</key><string>io.github.renjiegod.godbot.computerhost</string><key>CFBundleName</key><string>Godbot Computer Host</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/><key>NSScreenCaptureUsageDescription</key><string>Share a selected display with a controller you approve.</string></dict></plist>`,
    )
    run('codesign', ['--force', '--options', 'runtime', '--sign', signingIdentity(), app])
    run('codesign', ['--verify', '--strict', app])
  } else if (process.platform === 'linux') {
    copyFileSync(join(here, 'linux', 'desktop.py'), join(stage, capture))
    chmodSync(join(stage, capture), 0o755)
  } else {
    throw Error('Unsupported graphical platform')
  }
}
mkdirSync(dest, { recursive: true, mode: 0o700 })
const lock = join(dest, '.install-lock')
try {
  mkdirSync(lock)
} catch {
  throw Error('Another Godbot graphical installation is in progress')
}
const stage = mkdtempSync(join(dest, '.build-'))
const rollback = process.argv[2] === '--rollback'
try {
  if (rollback) {
    if (!files.every((file) => existsSync(join(previous, file))))
      throw Error('No complete previous graphical runtime')
    for (const file of files) renameSync(join(previous, file), join(stage, file))
  } else {
    build(stage)
  }
  const backup = join(stage, 'former')
  mkdirSync(backup)
  try {
    for (const file of files) {
      const target = join(dest, file)
      if (existsSync(target)) {
        renameSync(target, join(backup, file))
        saved.push(file)
      }
      renameSync(join(stage, file), target)
      installed.push(file)
    }
  } catch (error) {
    for (const file of installed.reverse()) renameSync(join(dest, file), join(stage, file))
    for (const file of saved.reverse()) renameSync(join(backup, file), join(dest, file))
    if (rollback) for (const file of files) renameSync(join(stage, file), join(previous, file))
    throw error
  }
  if (saved.length === files.length) {
    if (existsSync(previous)) renameSync(previous, join(stage, 'older'))
    renameSync(backup, previous)
  }
  process.stdout.write((rollback ? 'Restored' : 'Installed') + ' graphical helper in ' + dest + '\n')
} finally {
  rmSync(stage, { recursive: true, force: true })
  rmSync(lock, { recursive: true, force: true })
}
