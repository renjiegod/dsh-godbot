import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const encoderDirectory = fileURLToPath(new URL('./bundled-encoder', import.meta.url))
export const encoderBuild = 'ffmpeg-8.0.1-libvpx-1.17.0-darwin-arm64-v2'
export const encoderSources = [
  {
    name: 'ffmpeg-8.0.1.tar.xz', top: 'ffmpeg-8.0.1',
    url: 'https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz',
    sha256: '05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41',
  },
  {
    name: 'libvpx-v1.17.0.tar.gz', top: 'libvpx-1.17.0',
    url: 'https://codeload.github.com/webmproject/libvpx/tar.gz/refs/tags/v1.17.0',
    sha256: '1020f184046187baa2985dbde38e0691f49c44088bca7a1842b0236c6081dc0a',
  },
]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const encoderNotices = ['FFmpeg-LGPL-2.1.txt', 'libvpx-LICENSE', 'libvpx-PATENTS', 'BUILD.md']
const encoderRuntimeFiles = ['ffmpeg', 'manifest.json', ...encoderNotices]
const encoderSourceNames = encoderSources.map(source => source.name)

export function bundledEncoder(directory = encoderDirectory) {
  const manifest = join(directory, 'manifest.json')
  let raw
  try {
    const file = lstatSync(manifest)
    if (!file.isFile() || !file.size || file.size > 8192) throw new Error('Invalid bundled Mac video encoder manifest')
    raw = readFileSync(manifest, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  const info = JSON.parse(raw)
  const path = join(directory, 'ffmpeg')
  const file = lstatSync(path)
  if (info.build !== encoderBuild || !/^[a-f0-9]{64}$/u.test(info.sha256) ||
    !file.isFile() || file.size < 1024 || file.size > 8 * 1024 * 1024 ||
    file.size !== info.bytes || !(file.mode & 0o100) || sha256(readFileSync(path)) !== info.sha256) {
    throw new Error('The Mac video encoder does not match the Godbot package')
  }
  return { path, sha256: info.sha256 }
}

export function verifyEncoderDistribution(directory = encoderDirectory, { sources = false } = {}) {
  const names = readdirSync(directory)
  const includesSources = sources || encoderSourceNames.some(name => names.includes(name))
  const expected = includesSources ? [...encoderRuntimeFiles, ...encoderSourceNames] : encoderRuntimeFiles
  if (names.length !== expected.length || names.some(name => !expected.includes(name))) {
    throw new Error('Unexpected files in the bundled Mac video encoder directory')
  }
  const encoder = bundledEncoder(directory)
  if (!encoder) throw new Error('The bundled Mac video encoder is missing')
  for (const name of encoderNotices) {
    const file = lstatSync(join(directory, name))
    if (!file.isFile() || file.size < 32 || file.size > 64 * 1024) throw new Error('Invalid encoder distribution file: ' + name)
  }
  if (includesSources) for (const source of encoderSources) {
    const path = join(directory, source.name)
    const file = lstatSync(path)
    if (!file.isFile() || file.size > 12 * 1024 * 1024 || sha256(readFileSync(path)) !== source.sha256) {
      throw new Error('Invalid encoder source archive: ' + source.name)
    }
  }
  return encoder
}

export function prepareBundledEncoder(destination, expectedSha256) {
  const encoder = bundledEncoder()
  if (!encoder || encoder.sha256 !== expectedSha256) throw new Error('The bundled Mac video encoder is unavailable')
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  const staged = destination + '.' + randomUUID()
  try {
    copyFileSync(encoder.path, staged)
    chmodSync(staged, 0o700)
    if (sha256(readFileSync(staged)) !== encoder.sha256) throw new Error('Could not verify the staged video encoder')
    renameSync(staged, destination)
  } finally {
    rmSync(staged, { force: true })
  }
}
