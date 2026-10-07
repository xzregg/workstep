const fs = require('node:fs/promises')
const { createWriteStream } = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const upstream = 'https://github.com/containers/podman/releases/download/'
const ASSETS = {
  'darwin-arm64': { version: '5.6.2', url: upstream + 'v5.6.2/podman-installer-macos-arm64.pkg', sha256: 'bf45bea14045881732fc58ff49a472a40c922ad557279a0fb5497db6ebf57a1b', format: 'pkg' },
  'darwin-x64': { version: '5.6.2', url: upstream + 'v5.6.2/podman-installer-macos-amd64.pkg', sha256: 'a927e8396fa2cc8962eafc3dc853b2dae27d8661806d4ed3fbeefc1bc4e415f6', format: 'pkg' },
  'win32-x64': { version: '6.1.3', url: upstream + 'v6.1.3/podman-remote-release-windows_amd64.zip', sha256: 'bb98562f5faf0df3f28bab7fb517ea9e2d807817978bfa9f68982b75e6e59c40', format: 'zip' },
  'linux-x64': { version: '6.1.3', url: 'https://github.com/mgoltzsche/podman-static/releases/download/v6.1.3/podman-linux-amd64.tar.gz', sha256: 'dcfff14eae60569653c21eed75c96e5fd4140f23448637bc6e0ee75a12e1267a', format: 'tar' },
}

function run(file, args, { env = process.env, timeout = 600000, onOutput, captureCombined = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('沙箱命令执行超时')) }, timeout)
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-1024 * 1024); onOutput?.(String(data)) })
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-1024 * 1024); onOutput?.(String(data)) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve((captureCombined ? stdout + stderr : stdout).trim())
      else reject(new Error(`${path.basename(file)} 执行失败 (${code})：${stderr.trim().slice(-2000)}`))
    })
  })
}

async function download(asset, destination, report, fetchImpl = fetch) {
  if (typeof asset.url !== 'string' || !asset.url.startsWith('https://') || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('无效的运行时发布清单')
  const temporary = destination + '.partial'
  const hash = createHash('sha256')
  let received = 0
  try {
    const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(600000) })
    if (!response.ok || !response.body) throw new Error(`下载失败 (${response.status})`)
    const total = Number(response.headers.get('content-length')) || null
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      hash.update(chunk); received += chunk.length; report?.({ received, total }); callback(null, chunk)
    } })
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { mode: 0o600 }))
    if (hash.digest('hex') !== asset.sha256) throw new Error('运行时下载校验失败')
    await fs.rename(temporary, destination)
  } finally { await fs.rm(temporary, { force: true }) }
}

async function findFiles(directory, names) {
  const found = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await findFiles(child, names))
    else if (entry.isFile() && names.includes(entry.name)) found.push(child)
  }
  return found
}

function validateArchiveEntries(list) {
  for (const entry of list.split(/\r?\n/).filter(Boolean)) {
    if (/^[\\/]|^[A-Za-z]:/.test(entry) || entry.replaceAll('\\', '/').split('/').includes('..')) throw new Error('运行时归档包含越界路径')
  }
}

async function installRuntime(root, platform, arch, report) {
  const asset = ASSETS[`${platform}-${arch}`]
  if (!asset) throw new Error('当前系统或架构不支持桌面沙箱')
  const runtime = path.join(root, 'podman')
  await fs.mkdir(path.join(runtime, 'cache'), { recursive: true })
  const marker = path.join(runtime, 'runtime.json')
  try {
    const record = JSON.parse(await fs.readFile(marker, 'utf8'))
    if (record.sha256 === asset.sha256 && (await fs.stat(record.executable)).isFile()) return record
  } catch { /* download a fresh managed runtime */ }
  const archive = path.join(runtime, 'cache', `${asset.sha256}.${asset.format}`)
  await download(asset, archive, report)
  const stage = await fs.mkdtemp(path.join(runtime, '.runtime-'))
  try {
    if (asset.format === 'pkg') {
      // Expand the official installer; do not install it into host /opt or run scripts.
      await run('/usr/sbin/pkgutil', ['--expand-full', archive, path.join(stage, 'payload')])
    } else {
      validateArchiveEntries(await run('tar', ['-tf', archive]))
      await run('tar', ['-xf', archive, '-C', stage])
    }
    const executables = await findFiles(stage, [platform === 'win32' ? 'podman.exe' : 'podman'])
    if (!executables.length) throw new Error('安装包未包含 Podman')
    const target = path.join(runtime, 'bin', asset.sha256)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rm(target, { recursive: true, force: true })
    const relative = path.relative(stage, executables[0])
    await fs.rename(stage, target)
    const executable = path.join(target, relative)
    const helperFiles = await findFiles(target, ['gvproxy', 'vfkit', 'krunkit', 'win-sshproxy.exe', 'crun', 'pasta', 'slirp4netns', 'fuse-overlayfs', 'conmon', 'netavark', 'aardvark-dns', 'catatonit'])
    const record = { version: asset.version, sha256: asset.sha256, executable, helpers: [...new Set(helperFiles.map(file => path.dirname(file)))], crun: helperFiles.find(file => path.basename(file) === 'crun'), conmon: helperFiles.find(file => path.basename(file) === 'conmon') }
    await run(executable, ['--version'], { timeout: 10000 })
    await fs.writeFile(marker + '.tmp', JSON.stringify(record), { mode: 0o600 })
    await fs.rename(marker + '.tmp', marker)
    return record
  } finally { await fs.rm(stage, { recursive: true, force: true }) }
}

module.exports = { ASSETS, run, download, installRuntime, validateArchiveEntries }
