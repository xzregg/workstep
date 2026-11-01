const fs = require('node:fs/promises')
const { createWriteStream } = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const { Transform, Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const execute = promisify(execFile)
const { RELEASE_API_URL } = require('./desktop-update.cjs')

// Positional arguments keep paths (including spaces and quotes) out of shell code.
const INSTALL_SCRIPT = `
pid=$1; target=$2; staged=$3; backup=$4; opener=$5
count=0
while kill -0 "$pid" 2>/dev/null; do
  count=$((count + 1))
  [ "$count" -lt 120 ] || exit 1
  sleep 1
done
mv "$target" "$backup" || exit 1
if mv "$staged" "$target"; then
  if "$opener" "$target"; then
    rm -rf "$backup"
    rmdir "$(dirname "$staged")" 2>/dev/null || true
    exit 0
  fi
  mv "$target" "$staged"
fi
mv "$backup" "$target"
"$opener" "$target"
exit 0
`

function releaseAsset(release, name) {
  const assets = release?.assets?.filter(asset => asset.name === name) || []
  if (assets.length !== 1) throw new Error(`Release 缺少更新文件：${name}`)
  const url = new URL(assets[0].browser_download_url)
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/xzregg/workstep/releases/download/')) {
    throw new Error('更新文件地址无效')
  }
  return assets[0]
}

function macReleaseAsset(release, arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('当前架构不支持自动更新')
  return releaseAsset(release, `WorkStep-macos-${arch}.zip`)
}

function checksumFor(text, name) {
  const matches = text.split(/\r?\n/).map(line => line.match(/^([a-f\d]{64})\s+\*?(.+)$/i))
    .filter(match => match && match[2] === name)
  if (matches.length !== 1) throw new Error('更新文件缺少有效的 SHA-256 校验值')
  return matches[0][1].toLowerCase()
}

// Squirrel.Mac cannot update our ad-hoc signed releases. Stage and verify the
// complete bundle first, then let a detached system shell replace it after exit.
class MacBundleUpdater extends EventEmitter {
  constructor({ app, fetchImpl, arch = process.arch }) {
    super()
    this.app = app
    this.fetch = fetchImpl
    this.arch = arch
  }

  async response(url, timeout = 30_000) {
    const response = await this.fetch(url, {
      headers: { 'User-Agent': `WorkStep/${this.app.getVersion()}` },
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) throw new Error(`下载更新失败 (${response.status})`)
    return response
  }

  async checkForUpdates() {
    this.release = await (await this.response(RELEASE_API_URL)).json()
    return { updateInfo: { version: String(this.release.tag_name || '').replace(/^v/, '') } }
  }

  async downloadUpdate() {
    const asset = macReleaseAsset(this.release, this.arch)
    const sums = releaseAsset(this.release, 'SHA256SUMS.txt')
    const expected = checksumFor(await (await this.response(sums.browser_download_url)).text(), asset.name)
    const target = path.resolve(this.app.getAppPath(), '../../..')
    if (!target.endsWith('.app') || target.startsWith('/Volumes/') || target.includes('/AppTranslocation/')) {
      throw new Error('请先将 WorkStep 移到应用程序目录，再使用自动更新')
    }
    // Sibling staging checks write permissions before shutdown and keeps renames
    // on the same filesystem. Never modify the running bundle while downloading.
    const stage = await fs.mkdtemp(path.join(path.dirname(target), '.workstep-update-'))
    try {
      const archive = path.join(stage, asset.name)
      const response = await this.response(asset.browser_download_url, 30 * 60_000)
      const hash = createHash('sha256')
      let received = 0
      const total = asset.size || Number(response.headers.get('content-length'))
      await pipeline(Readable.fromWeb(response.body), new Transform({
        transform: (chunk, _encoding, callback) => {
          hash.update(chunk); received += chunk.length
          this.emit('download-progress', { percent: total ? received / total * 100 : 0 })
          callback(null, chunk)
        },
      }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
      if (hash.digest('hex') !== expected) throw new Error('更新文件校验失败，请重新下载')
      await execute('/usr/bin/ditto', ['-x', '-k', archive, stage])
      const staged = path.join(stage, 'WorkStep.app')
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged])
      const plist = path.join(staged, 'Contents/Info.plist')
      const readPlist = async key => (await execute('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim()
      if (await readPlist('CFBundleIdentifier') !== 'com.workstep.desktop'
        || await readPlist('CFBundleShortVersionString') !== this.release.tag_name.replace(/^v/, '')) {
        throw new Error('更新包的应用标识或版本不匹配')
      }
      await fs.unlink(archive)
      this.installation = { target, staged, stage }
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true })
      throw error
    }
  }

  async prepareInstall() {
    const { target, staged, stage } = this.installation
    const log = await fs.open(path.join(this.app.getPath('userData'), 'desktop-update-install.log'), 'w', 0o600)
    try {
      const child = spawn('/bin/sh', ['-c', `${INSTALL_SCRIPT}\n`, 'workstep-update',
        String(process.pid), target, staged, path.join(stage, 'previous.app'), '/usr/bin/open'],
      { detached: true, stdio: ['ignore', log.fd, log.fd] })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
    } finally { await log.close() }
  }

  quitAndInstall() { this.app.quit() }
}

module.exports = { MacBundleUpdater, macReleaseAsset, checksumFor, INSTALL_SCRIPT }
