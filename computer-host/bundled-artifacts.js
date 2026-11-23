import { execFile } from 'node:child_process'
import { createHash, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const bundledHostVersion = '0.1.2'
export const bundledHostSource = 'https://github.com/renjiegod/dsh-godbot/releases/download/v0.2.0-rc.22/'
export const bundledPublisherKeyPath = fileURLToPath(new URL('bundled-publisher.pem', import.meta.url))
export const bundledHostAssetsDir = fileURLToPath(new URL('bundled', import.meta.url))
export const bundledHostManifests = Object.freeze({
  host: 'c946965857b51905609369555f84b80dc8502dffcc3cf4644fb630b127ad0896',
  desktop: '7a7c7cc306e99b0bc2595cc8bf819ceee987a5dc1c199bd73afed1ab4791267e',
})

const publisherSha256 = '5fcb73dc6cfc6995df41b0fa2f2ed7418a1aae8a03b3b4da0b2c0a27563e27b4'
const releaseManifest = 'godbot-computer-0.1.2.json'
const releaseSourceCommit = '80af4b90afadf3e879fbb0c4151a43b6b1523e73'
const host = 'godbot-computer-host-0.1.2-darwin-arm64'
const desktop = 'godbot-computer-desktop-0.1.2-darwin-arm64'
export const bundledHostAssets = Object.freeze({
  [releaseManifest]: [2844, '276cb03ef61f1bacb8567c91ee8ef6d388411773b2829f02a4db5d1997fc7448'],
  [releaseManifest + '.sig']: [70, 'f0fd2039650b10b581b79bd9b281a032cc8df868d72afc19050bce2745ea5cf4'],
  [host + '.tar.gz']: [39457689, '8bea91c22fa3dba0e55d5f68a24227a6372f4260c4a989368da462026204b12c'],
  [host + '.tar.gz.sig']: [72, '0567470fb0c4b626749924178633dc50a325fccbb80bb1a7645a92b885fd32e4'],
  [desktop + '.tar.gz']: [3526592, '6cdd993cd4302963476780fd4b6e430b72ddef03f95a2470cff34b336c53adc0'],
  [desktop + '.tar.gz.sig']: [72, '258eb7cb0c43bb12850dbaee8a1a9bd7c1bf3c7c003749d2aa77d3268776b787'],
})

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const components = { host, desktop }

export async function readBundledHostAssets(directory = bundledHostAssetsDir, {
  publisherKeyPath = bundledPublisherKeyPath,
  exact = directory === bundledHostAssetsDir,
} = {}) {
  if (exact) {
    const names = await readdir(directory)
    if (names.length !== Object.keys(bundledHostAssets).length || names.some(name => !Object.hasOwn(bundledHostAssets, name))) {
      throw new Error('Unexpected files in the bundled Computer Host directory')
    }
  }
  const key = await readFile(publisherKeyPath)
  if (sha256(key) !== publisherSha256) throw new Error('Bundled Computer Host publisher key does not match its pin')

  const files = new Map(await Promise.all(Object.entries(bundledHostAssets).map(async ([name, [size, digest]]) => {
    const path = join(directory, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size !== size) throw new Error('Unexpected bundled Computer Host asset: ' + name)
    const bytes = await readFile(path)
    if (bytes.length !== size || sha256(bytes) !== digest) throw new Error('Bundled Computer Host checksum mismatch: ' + name)
    return [name, bytes]
  })))
  for (const name of [releaseManifest, host + '.tar.gz', desktop + '.tar.gz']) {
    if (!verify('sha256', files.get(name), key, files.get(name + '.sig'))) {
      throw new Error('Invalid bundled Computer Host publisher signature: ' + name)
    }
  }

  const manifest = JSON.parse(files.get(releaseManifest))
  if (manifest.version !== bundledHostVersion || manifest.publisherPublicKeySha256 !== publisherSha256
    || manifest.sourceCommit !== releaseSourceCommit) {
    throw new Error('Unexpected bundled Computer Host release metadata')
  }
  for (const [component, base] of Object.entries(components)) {
    const filename = base + '.tar.gz'
    const pinned = manifest.archives.filter(item => item.filename === filename)
    const [size, digest] = bundledHostAssets[filename]
    if (pinned.length !== 1 || pinned[0].component !== component || pinned[0].platform !== 'darwin'
      || pinned[0].arch !== 'arm64' || pinned[0].bytes !== size || pinned[0].sha256 !== digest
      || pinned[0].manifestSha256 !== bundledHostManifests[component]) {
      throw new Error('Unexpected bundled Computer Host component metadata: ' + component)
    }
  }
  return { files, key }
}

async function extract(destination, archive) {
  // Only extract the exact pinned, signature-verified bytes into the caller's private directory.
  await new Promise((resolve, reject) => {
    const child = execFile('tar', ['-xzf', '-', '-C', destination], { timeout: 30_000 }, err => {
      if (err) reject(err)
      else resolve()
    })
    child.stdin.on('error', reject)
    child.stdin.end(archive)
  })
}

async function verifyExtracted(directory, component, key) {
  const manifest = await readFile(join(directory, 'manifest.json'))
  const signature = await readFile(join(directory, 'manifest.sig'))
  if (sha256(manifest) !== bundledHostManifests[component] || !verify('sha256', manifest, key, signature)) {
    throw new Error('Invalid bundled Computer Host component manifest signature: ' + component)
  }
  const contents = JSON.parse(manifest)
  if (contents.version !== bundledHostVersion || contents.component !== component ||
      contents.platform !== 'darwin' || contents.arch !== 'arm64') {
    throw new Error('Unexpected bundled Computer Host component manifest: ' + component)
  }
  const expected = new Map(Object.entries(contents.files))
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue
    const path = join(entry.parentPath, entry.name)
    const name = relative(directory, path).split(sep).join('/')
    if (!entry.isFile()) throw new Error('Unsafe bundled Computer Host entry: ' + name)
    if (name === 'manifest.json' || name === 'manifest.sig') continue
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path)) digest.update(chunk)
    if (digest.digest('hex') !== expected.get(name)) throw new Error('Corrupt bundled Computer Host entry: ' + name)
    expected.delete(name)
  }
  if (expected.size) throw new Error('Bundled Computer Host component files are missing: ' + component)
}

export async function prepareBundledHost(destination) {
  if (!(await lstat(destination)).isDirectory() || (await readdir(destination)).length) {
    throw new Error('Bundled Computer Host extraction needs an empty private directory')
  }
  const { files, key } = await readBundledHostAssets()
  const directories = {}
  for (const [component, base] of Object.entries(components)) {
    const directory = join(destination, base)
    await extract(destination, files.get(base + '.tar.gz'))
    await verifyExtracted(directory, component, key)
    directories[component] = directory
  }
  return {
    version: bundledHostVersion,
    publisherKeyPath: bundledPublisherKeyPath,
    hostDir: directories.host,
    desktopDir: directories.desktop,
    manifests: bundledHostManifests,
  }
}
