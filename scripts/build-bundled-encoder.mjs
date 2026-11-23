// Build the Mac BGRA-to-VP8 encoder from corresponding source for the plugin archive.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { availableParallelism, homedir } from 'node:os'
import { basename, join } from 'node:path'
import { encoderBuild, encoderDirectory, encoderSources as inputs, verifyEncoderDistribution } from '../computer-host/bundled-encoder.js'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Build the bundled encoder on an Apple silicon Mac')
}

const cache = join(homedir(), '.cache/godbot-bundled-encoder')
const cached = join(cache, encoderBuild)
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: '12.3', LC_ALL: 'C' }
const jobs = String(Math.min(8, availableParallelism()))
const valid = directory => {
  try {
    return Boolean(verifyEncoderDistribution(directory, { sources: true }))
  } catch {
    return false
  }
}

function run(command, args, { cwd, input, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, env, input, maxBuffer: 4 * 1024 * 1024, stdio: [input ? 'pipe' : 'ignore', capture ? 'pipe' : 'inherit', 'inherit'],
  })
  if (result.status !== 0) throw new Error(result.error?.message || `${basename(command)} exited with status ${result.status}`)
  return result.stdout
}

function getSource(source) {
  const path = join(cache, source.name)
  if (existsSync(path) && sha256(path) === source.sha256) return path
  const folder = mkdtempSync(join(cache, '.download-'))
  try {
    const target = join(folder, source.name)
    run('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '90', source.url, '--output', target])
    if (sha256(target) !== source.sha256) throw new Error('Unexpected source checksum for ' + source.name)
    renameSync(target, path)
    return path
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

const libvpxOptions = [
  '--target=arm64-darwin20-gcc', '--disable-examples', '--disable-tools', '--disable-docs',
  '--disable-unit-tests', '--disable-shared', '--enable-static', '--disable-vp9', '--disable-vp8-decoder',
]
const ffmpegOptions = [
  '--disable-all', '--disable-autodetect', '--pkg-config=/usr/bin/false', '--disable-network', '--disable-doc', '--disable-ffprobe',
  '--disable-shared', '--enable-static', '--enable-ffmpeg', '--enable-avcodec', '--enable-avfilter',
  '--enable-avformat', '--enable-swscale', '--enable-swresample', '--enable-pthreads', '--enable-libvpx',
  '--enable-encoder=libvpx_vp8', '--enable-decoder=rawvideo', '--enable-demuxer=rawvideo',
  '--enable-muxer=ivf', '--enable-protocol=pipe', '--enable-filter=scale,format,null,trim',
]

function build(destination) {
  const folder = mkdtempSync(join(cache, '.build-'))
  try {
    const [ffmpeg, libvpx] = inputs.map(source => {
      const archive = getSource(source)
      run('/usr/bin/tar', ['-xf', archive, '-C', folder])
      copyFileSync(archive, join(destination, source.name))
      return join(folder, source.top)
    })
    const prefix = join(folder, 'vpx')
    run('./configure', [...libvpxOptions, '--prefix=' + prefix], { cwd: libvpx })
    run('make', ['-j', jobs], { cwd: libvpx })
    run('make', ['install'], { cwd: libvpx })
    run('./configure', [
      ...ffmpegOptions, '--extra-cflags=-I' + prefix + '/include', '--extra-ldflags=-L' + prefix + '/lib',
    ], { cwd: ffmpeg })
    run('make', ['-j', jobs, 'ffmpeg'], { cwd: ffmpeg })
    const executable = join(destination, 'ffmpeg')
    copyFileSync(join(ffmpeg, 'ffmpeg'), executable)
    chmodSync(executable, 0o755)
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'io.github.renjiegod.godbot.ffmpeg', executable])
    run('/usr/bin/codesign', ['--verify', '--strict', executable])
    const dependencies = run('/usr/bin/otool', ['-L', executable], { capture: true }).toString().trimEnd().split('\n').slice(1)
    if (dependencies.some(line => !/^\s*(?:\/usr\/lib\/|\/System\/Library\/)/u.test(line))) {
      throw new Error('The bundled encoder uses a non-system library')
    }
    const ivf = run(executable, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'bgra',
      '-video_size', '64x64', '-framerate', '15', '-i', 'pipe:0', '-an', '-c:v', 'libvpx',
      '-pix_fmt', 'yuv420p', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '2',
      '-lag-in-frames', '0', '-g', '15', '-b:v', '350k', '-maxrate', '400k', '-bufsize', '350k',
      '-drop-threshold', '30', '-flush_packets', '1', '-f', 'ivf', 'pipe:1',
    ], { input: Buffer.alloc(64 * 64 * 4 * 3, 127), capture: true })
    if (ivf.length <= 44 || ivf.toString('ascii', 0, 4) !== 'DKIF' || ivf.toString('ascii', 8, 12) !== 'VP80') {
      throw new Error('The bundled encoder did not generate a VP8 IVF stream')
    }
    copyFileSync(join(ffmpeg, 'COPYING.LGPLv2.1'), join(destination, 'FFmpeg-LGPL-2.1.txt'))
    copyFileSync(join(libvpx, 'LICENSE'), join(destination, 'libvpx-LICENSE'))
    copyFileSync(join(libvpx, 'PATENTS'), join(destination, 'libvpx-PATENTS'))
    writeFileSync(join(destination, 'BUILD.md'), [
      '# Godbot macOS video encoder', '',
      'Godbot invokes FFmpeg as a separate executable for BGRA-to-VP8 conversion.',
      'FFmpeg is licensed under the LGPL 2.1 or later. libvpx is BSD licensed.',
      'The license files ship with the executable. The exact corresponding unmodified source archives are available beside the plugin archive in its GitHub release.', '',
      'Build with Apple clang for macOS arm64. Set `MACOSX_DEPLOYMENT_TARGET=12.3`.', '',
      '```sh', 'prefix=/absolute/path/to/vpx', '# In the libvpx source:',
      './configure ' + libvpxOptions.join(' ') + ' --prefix="$prefix"',
      'make -j8 && make install', '# In the FFmpeg source:',
      './configure ' + ffmpegOptions.join(' ') + ' --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib"',
      'make -j8 ffmpeg', '```', '',
      ...inputs.map(source => `- [${source.name}](${source.url}) · SHA-256 \`${source.sha256}\``), '',
    ].join('\n'))
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify({
      build: encoderBuild, sha256: sha256(executable), bytes: readFileSync(executable).length,
    }, null, 2) + '\n')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

if (!valid(encoderDirectory)) {
  mkdirSync(cache, { recursive: true, mode: 0o700 })
  if (!valid(cached)) {
    const fresh = mkdtempSync(join(cache, '.encoder-'))
    try {
      build(fresh)
      if (!valid(fresh)) throw new Error('The encoder build is incomplete')
      if (!valid(cached)) {
        rmSync(cached, { recursive: true, force: true })
        renameSync(fresh, cached)
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  }
  rmSync(encoderDirectory, { recursive: true, force: true })
  cpSync(cached, encoderDirectory, { recursive: true })
}
console.log('Staged ' + encoderBuild + ' from verified sources.')
