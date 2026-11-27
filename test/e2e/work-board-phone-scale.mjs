import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { channel } from './cases/WORK-BOARD.mjs'

const percentile = (times) => Math.round([...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1])
// Accessiblity first identifies the real card. Pixel matching then timestamps when
// it is painted; repeatedly asking UIAutomator for its tree includes its idle timeout.
function painted(ui, bounds) {
  const buffer = ui.adb(['exec-out', 'screencap'], { binary: true }),
    w = buffer.readUInt32LE(0),
    h = buffer.readUInt32LE(4)
  const offset = buffer.length - 4 * w * h
  assert.ok(offset >= 12 && offset < 64, 'RGBA emulator screen capture')
  const digest = createHash('sha256')
  const x1 = Math.max(0, bounds.x1 + 6),
    x2 = Math.min(w, bounds.x2 - 6)
  for (let y = Math.max(0, bounds.y1 + 5); y < Math.min(h, bounds.y2 - 5); y += 3)
    digest.update(buffer.subarray(offset + (y * w + x1) * 4, offset + (y * w + x2) * 4))
  return digest.digest('hex')
}
async function waitPaint(ui, bounds, reference) {
  const end = performance.now() + 8000
  while (performance.now() < end) {
    if (painted(ui, bounds) === reference) return
    await delay(35)
  }
  throw new Error('The expected Android card did not finish painting')
}
export async function phoneScale({ ui, host, tap, note }) {
  const row = await ui.waitFor((nodes) => ui.find(nodes, /GB-\d+.*Active scale job/i), 'first real card')
  const reference = painted(ui, row.bounds),
    paints = [],
    sync = []
  for (let n = 0; n < 30; n++) {
    ui.shell('input keyevent 4')
    await tap('team drawer', 'Open team list', '打开团队列表')
    const entry = await ui.waitFor((nodes) => ui.find(nodes, 'Work board', '工作看板'), 'native board shortcut')
    const start = performance.now()
    ui.tap(entry)
    await waitPaint(ui, row.bounds, reference)
    paints.push(performance.now() - start)
  }
  const first = 'Board latency alpha',
    second = 'Board latency ocean'
  let item = await channel(host, 'board-action', {
    op: 'create',
    title: first,
    priority: 1,
    requestId: 'paint-draft',
  })
  const find = async (title) =>
    ui.waitFor((nodes) => ui.find(nodes, new RegExp(item.id + '.*' + title)), 'the updated card title')
  const alpha = await find(first),
    hash1 = painted(ui, alpha.bounds)
  const edit = async (title, i) => {
    item = await channel(host, 'board-action', {
      op: 'edit',
      id: item.id,
      version: item.version,
      title,
      requestId: 'paint-' + i,
    })
  }
  await edit(second, 'initial')
  const ocean = await find(second),
    hash2 = painted(ui, ocean.bounds)
  assert.notEqual(hash1, hash2)
  for (let n = 0; n < 30; n++) {
    const next = n % 2 === 0
    const start = performance.now()
    await edit(next ? first : second, n)
    await waitPaint(ui, next ? alpha.bounds : ocean.bounds, next ? hash1 : hash2)
    sync.push(performance.now() - start)
  }
  const result = {
    samples: 30,
    history: 10000,
    active: 100,
    androidPaintP95: percentile(paints),
    webToAndroidP95: percentile(sync),
    device: ui.shell('getprop ro.product.model').trim(),
  }
  note('android-board-scale', result)
  assert.ok(result.androidPaintP95 <= 2000, 'Android first paint: ' + result.androidPaintP95)
  assert.ok(result.webToAndroidP95 <= 2000, 'Web to Android: ' + result.webToAndroidP95)
}
