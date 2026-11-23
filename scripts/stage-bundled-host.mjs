import { execFileSync } from 'node:child_process'
import { lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bundledHostAssets,
  bundledHostAssetsDir,
  bundledHostSource,
  readBundledHostAssets,
} from '../computer-host/bundled-artifacts.js'

const root = new URL('../', import.meta.url)
const encoderDirectory = fileURLToPath(new URL('computer-host/bundled-encoder', root))

async function existingStage(directory) {
  try {
    const stat = await lstat(directory)
    if (!stat.isDirectory()) throw new Error('Packaged Computer Host stage is not a directory: ' + directory)
    return true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

async function downloadAsset(name, size) {
  const response = await fetch(new URL(name, bundledHostSource), { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error('Cannot download Computer Host asset ' + name + ': HTTP ' + response.status)
  const chunks = []
  let received = 0
  for await (const chunk of response.body) {
    received += chunk.length
    if (received > size) throw new Error('Computer Host asset exceeds expected size: ' + name)
    chunks.push(chunk)
  }
  if (received !== size) throw new Error('Unexpected Computer Host asset size: ' + name)
  return Buffer.concat(chunks, received)
}

const override = process.env.GODBOT_BUNDLED_HOST_ASSETS_DIR
const supplied = override ? (await readBundledHostAssets(resolve(override))).files : null

if (await existingStage(bundledHostAssetsDir)) {
  await readBundledHostAssets()
} else {
  const staging = await mkdtemp(join(dirname(dirname(bundledHostAssetsDir)), '.godbot-host-stage-'))
  try {
    const results = await Promise.allSettled(Object.entries(bundledHostAssets).map(async ([name, [size]]) => {
      const bytes = supplied?.get(name) ?? await downloadAsset(name, size)
      await writeFile(join(staging, name), bytes)
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
    await readBundledHostAssets(staging, { exact: true })
    try {
      await rename(staging, bundledHostAssetsDir)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !await existingStage(bundledHostAssetsDir)) throw error
      // Concurrent packaging can only reuse an identical verified stage.
      await readBundledHostAssets()
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

const needsEncoder = process.platform === 'darwin' && process.arch === 'arm64'
if (needsEncoder && !await existingStage(encoderDirectory)) {
  execFileSync(process.execPath, ['scripts/build-bundled-encoder.mjs'], { cwd: root, stdio: 'inherit' })
}
if (await existingStage(encoderDirectory)) {
  const { verifyEncoderDistribution } = await import('../computer-host/bundled-encoder.js')
  await verifyEncoderDistribution(encoderDirectory)
} else if (needsEncoder) {
  throw new Error('The Apple silicon desktop encoder was not staged')
}
