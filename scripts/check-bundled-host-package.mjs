import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { bundledHostAssets, readBundledHostAssets } from '../computer-host/bundled-artifacts.js'

if (!process.argv[2]) throw new Error('Specify the dsh-godbot package archive')
const archive = resolve(process.argv[2])
// Packages must remain readable by the updater already installed in rc.27.
gunzipSync(await readFile(archive), { maxOutputLength: 64 * 1024 * 1024 })
const prefix = 'package/computer-host/'
const assetPrefix = prefix + 'bundled/'
const encoderPrefix = prefix + 'bundled-encoder/'
const publisher = prefix + 'bundled-publisher.pem'
const expected = [publisher, ...Object.keys(bundledHostAssets).map(name => assetPrefix + name)].sort()
const listed = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n')
const actual = listed.filter(name => name === publisher || name.startsWith(assetPrefix)).sort()
if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
  throw new Error('The dsh-godbot archive does not contain the complete pinned Computer Host bundle')
}
const encoderFiles = listed.filter(name => name.startsWith(encoderPrefix))
const needsEncoder = process.argv.includes('--require-encoder') || process.platform === 'darwin' && process.arch === 'arm64'
if (needsEncoder || encoderFiles.length) {
  if (!encoderFiles.includes(encoderPrefix + 'ffmpeg') || !encoderFiles.includes(encoderPrefix + 'manifest.json')
      || new Set(encoderFiles).size !== encoderFiles.length
      || encoderFiles.some(name => name.split('/').some(part => !part || part === '.' || part === '..'))) {
    throw new Error('The dsh-godbot archive does not contain a valid desktop encoder bundle')
  }
}

const staging = await mkdtemp(join(tmpdir(), 'godbot-check-bundle-'))
try {
  execFileSync('tar', ['-xzf', archive, '-C', staging, ...expected, ...encoderFiles])
  await readBundledHostAssets(join(staging, assetPrefix), {
    publisherKeyPath: join(staging, publisher),
    exact: true,
  })
  if (encoderFiles.length) {
    const { verifyEncoderDistribution } = await import('../computer-host/bundled-encoder.js')
    if (encoderFiles.some(name => /\.tar\.(gz|xz)$/u.test(name))) {
      throw new Error('The desktop encoder source archives are separate release assets')
    }
    await verifyEncoderDistribution(join(staging, encoderPrefix))
  }
} finally {
  await rm(staging, { recursive: true, force: true })
}
