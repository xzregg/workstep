const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const execFile = promisify(require('node:child_process').execFile)
const { MacBundleUpdater, macReleaseAsset, checksumFor, INSTALL_SCRIPT } = require('../src/macos-update.cjs')

test('mac update selects exact architecture and trusted release asset', () => {
  const url = 'https://github.com/xzregg/workstep/releases/download/v2.0.0/'
  const release = { assets: ['arm64', 'x64'].map(arch => ({ name: `WorkStep-macos-${arch}.zip`, browser_download_url: `${url}WorkStep-macos-${arch}.zip` })) }
  assert.match(macReleaseAsset(release, 'arm64').name, /arm64/)
  assert.throws(() => macReleaseAsset(release, 'ia32'))
  release.assets[0].browser_download_url = 'https://evil.test/file.zip'
  assert.throws(() => macReleaseAsset(release, 'arm64'))
})

test('checksum must exist exactly once with a complete SHA256 digest', () => {
  const digest = 'a'.repeat(64), name = 'WorkStep-macos-arm64.zip'
  assert.equal(checksumFor(`${digest}  ${name}\n`, name), digest)
  for (const text of ['', `${digest}  other.zip`, `abc  ${name}`, `${digest}  ${name}\n`.repeat(2)]) {
    assert.throws(() => checksumFor(text, name))
  }
})

test('mac installer replaces bundle after exit, and rolls back when relaunch fails', async () => {
  for (const fail of [false, true]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-update-test-'))
    try {
      const target = path.join(directory, "中文 Work'Step.app"), staged = path.join(directory, 'new.app')
      await fs.mkdir(target); await fs.mkdir(staged)
      await fs.writeFile(path.join(target, 'version'), 'old')
      await fs.writeFile(path.join(staged, 'version'), 'new')
      const open = path.join(directory, 'open')
      await fs.writeFile(open, `#!/bin/sh\nexit ${fail ? 1 : 0}\n`, { mode: 0o700 })
      await execFile('/bin/sh', ['-c', INSTALL_SCRIPT, 'workstep-update', '99999999', target, staged, `${target}.backup`, open])
      assert.equal(await fs.readFile(path.join(target, 'version'), 'utf8'), fail ? 'old' : 'new')
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  }
})

test('corrupted streamed downloads are rejected and cleaned without changing the installed app', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-download-test-'))
  const name = 'WorkStep-macos-arm64.zip'
  const base = 'https://github.com/xzregg/workstep/releases/download/v2.0.0/'
  const release = { tag_name: 'v2.0.0', assets: [name, 'SHA256SUMS.txt'].map(name => ({ name, browser_download_url: base + name, size: 7 })) }
  const app = { getVersion: () => '1.0.0', getAppPath: () => path.join(directory, 'WorkStep.app/Contents/Resources/app.asar') }
  const updater = new MacBundleUpdater({ app, arch: 'arm64', fetchImpl: async url => {
    if (url.endsWith('/latest')) return Response.json(release)
    return new Response(url.endsWith('SHA256SUMS.txt') ? `${'a'.repeat(64)}  ${name}\n` : 'corrupt')
  } })
  try {
    await fs.mkdir(path.join(directory, 'WorkStep.app'))
    const progress = []
    updater.on('download-progress', event => progress.push(event.percent))
    await updater.checkForUpdates()
    await assert.rejects(updater.downloadUpdate(), /校验失败/)
    assert.deepEqual(await fs.readdir(directory), ['WorkStep.app'])
    assert.deepEqual(progress, [100])
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
