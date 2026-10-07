const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { SandboxManager, validateSettings, containerArgs, windowsPath } = require('../src/sandbox.cjs')

test('mounts are limited to distinct project paths and never contain sandbox storage', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-sandbox-test-'))
  try {
    await fs.mkdir(path.join(base, 'project'))
    const config = { root: path.join(base, 'sandbox'), project: path.join(base, 'project'), mounts: [] }
    assert.equal((await validateSettings(config)).root, path.join(await fs.realpath(base), 'sandbox'))
    await assert.rejects(validateSettings({ ...config, project: base }), /重叠/)
    await assert.rejects(validateSettings({ ...config, mounts: [{ source: config.project, target: '/root' }] }), /项目/)
    await assert.rejects(validateSettings({ ...config, mounts: [{ source: config.project, target: '/data/projects' }] }), /项目|重复/)
    const link = path.join(base, 'link'); await fs.symlink(base, link)
    await assert.rejects(validateSettings({ ...config, root: path.join(link, 'project/sandbox') }), /重叠/)
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('container only publishes loopback and does not expose container-management sockets', () => {
  const args = containerArgs({ root: '/sandbox', project: '/project', mounts: [], id: 'abc', image: 'registry/image@sha256:' + 'a'.repeat(64) }, 'linux', 43210, 'secret', {})
  assert.ok(args.includes('127.0.0.1:43210:8765'))
  assert.ok(args.some(a => a.includes('source=/sandbox/home,target=/root')))
  assert.ok(args.some(a => a.includes('source=/project,target=/data/projects')))
  assert.ok(!args.includes('--privileged'))
  assert.ok(!args.join(' ').includes('docker.sock'))
  assert.ok(args.includes('WORKSTEP_DESKTOP_TOKEN=secret'))
  assert.ok(args.includes('WORKSTEP_PROJECTS_ROOT=/data/projects'))
  assert.equal(windowsPath('C:\\Users\\A B\\project'), '/mnt/c/Users/A B/project')
})

test('failed preparation never changes active settings and can be retried', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-sandbox-test-'))
  try {
    await fs.mkdir(path.join(base, 'project'))
    const manager = new SandboxManager({ stateDir: path.join(base, 'state'), platform: 'linux', arch: 'x64', image: 'ghcr.io/test/workstep@sha256:' + 'a'.repeat(64), install: async () => { throw new Error('download failed') } })
    await assert.rejects(manager.prepare({ root: path.join(base, 'sandbox'), project: path.join(base, 'project'), mounts: [] }), /download failed/)
    assert.equal((await manager.status()).settings.enabled, false)
    assert.equal((await manager.status()).phase, 'error')
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('Compose Home survives failed preparation, retry and sandbox removal', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-compose-home-'))
  try {
    const root = path.join(base, 'data'), project = path.join(base, 'projects')
    await fs.mkdir(path.join(root, 'home/.workstep'), { recursive: true }); await fs.mkdir(project)
    await fs.writeFile(path.join(root, 'home/.workstep/config.json'), 'existing')
    await fs.writeFile(path.join(root, '.DS_Store'), 'finder')
    const manager = new SandboxManager({ stateDir: path.join(base, 'state'), image: 'ghcr.io/test/workstep@sha256:' + 'a'.repeat(64), install: async () => { throw new Error('download failed') } })
    await assert.rejects(manager.prepare({ root, project, mounts: [] }), /download failed/)
    await manager.claimRoot(await validateSettings({ root, project, mounts: [] }))
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'desktop/owner.json'), 'utf8')).preserveHome, true)
    await manager.remove()
    assert.equal(await fs.readFile(path.join(root, 'home/.workstep/config.json'), 'utf8'), 'existing')
    assert.equal(await fs.readFile(path.join(root, '.DS_Store'), 'utf8'), 'finder')
    await assert.rejects(fs.stat(path.join(root, 'podman'))); await assert.rejects(fs.stat(path.join(root, 'desktop')))
    assert.ok((await fs.stat(project)).isDirectory())
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('adoption refuses unrelated contents and external Home links', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-compose-reject-'))
  try {
    const root = path.join(base, 'data'), project = path.join(base, 'projects')
    await fs.mkdir(root); await fs.mkdir(project)
    const config = await validateSettings({ root, project, mounts: [] })
    const manager = new SandboxManager({ stateDir: path.join(base, 'state') })
    await fs.writeFile(path.join(root, 'important'), 'keep')
    await assert.rejects(manager.claimRoot(config), /空|home/)
    assert.equal(await fs.readFile(path.join(root, 'important'), 'utf8'), 'keep')
    await fs.rm(path.join(root, 'important')); await fs.symlink(project, path.join(root, 'home'))
    await assert.rejects(manager.claimRoot(config), /Home|home|外部/)
    await assert.rejects(fs.stat(path.join(root, 'desktop')))
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('import backs up old configuration and refuses symlinks out of source', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-sandbox-test-'))
  try {
    const root = path.join(await fs.realpath(base), 'sandbox'), host = path.join(base, 'host')
    await fs.mkdir(path.join(root, 'home/.codex'), { recursive: true }); await fs.mkdir(path.join(host, '.codex'), { recursive: true })
    await fs.writeFile(path.join(root, 'home/.codex/auth.json'), 'old')
    await fs.writeFile(path.join(host, '.codex/auth.json'), 'new')
    await fs.writeFile(path.join(base, 'outside'), 'private'); await fs.symlink(path.join(base, 'outside'), path.join(host, '.codex/escape'))
    const manager = new SandboxManager({ stateDir: path.join(base, 'state'), hostHome: host })
    await manager.save({ enabled: false, root, project: path.join(base, 'project'), mounts: [], id: 'test' })
    await fs.mkdir(path.join(root, 'desktop'), { recursive: true })
    await fs.writeFile(path.join(root, 'desktop/owner.json'), JSON.stringify({ id: 'test' }))
    await manager.importConfig('codex')
    assert.equal(await fs.readFile(path.join(root, 'home/.codex/auth.json'), 'utf8'), 'new')
    await assert.rejects(fs.stat(path.join(root, 'home/.codex/escape')))
    assert.ok((await fs.readdir(path.join(root, 'desktop/backups'))).length)
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('runtime downloads are checked before committing archives', async () => {
  const { download, validateArchiveEntries } = require('../src/sandbox-runtime.cjs')
  const { createHash } = require('node:crypto')
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-download-'))
  try {
    const destination = path.join(base, 'runtime.tar')
    const data = Buffer.from('known runtime archive')
    const asset = { url: 'https://example.test/runtime', sha256: createHash('sha256').update(data).digest('hex') }
    let progress
    await download(asset, destination, value => { progress = value }, async () => new Response(data))
    assert.equal(await fs.readFile(destination, 'utf8'), String(data))
    assert.equal(progress.received, data.length)
    await assert.rejects(download({ ...asset, sha256: '0'.repeat(64) }, destination, null, async () => new Response(data)), /校验/)
    assert.equal(await fs.readFile(destination, 'utf8'), String(data))
    await assert.rejects(fs.stat(destination + '.partial'))
    assert.throws(() => validateArchiveEntries('bin/podman\n../escape'), /越界/)
    assert.throws(() => validateArchiveEntries('C:\\escape'), /越界/)
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('privileged IPC refuses foreign frames, active work, and unchosen host paths', async () => {
  const { registerSandboxIpc } = require('../src/sandbox-ipc.cjs')
  const handlers = new Map(), webContents = {}, window = { webContents }
  let active = false
  const manager = { settings: async () => ({ root: '', project: '', mounts: [] }), status: async () => ({ phase: 'idle', settings: { root: '', project: '', mounts: [] } }), prepare: async () => 'prepared' }
  registerSandboxIpc({ ipcMain: { removeHandler() {}, handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/chosen'] }) }, shell: {}, manager,
    window: () => window, rootUrl: () => 'http://127.0.0.1:12345', hasActiveWork: async () => active, restart() {} })
  const event = { sender: webContents, senderFrame: { url: 'http://127.0.0.1:12345/' } }
  await assert.rejects(handlers.get('workstep:sandbox:status')({ ...event, senderFrame: { url: 'https://evil.test' } }), /来源/)
  await assert.rejects(handlers.get('workstep:sandbox:prepare')(event, { root: '/unapproved', project: '/chosen' }), /授权/)
  await handlers.get('workstep:sandbox:chooseDirectory')(event)
  assert.equal(await handlers.get('workstep:sandbox:prepare')(event, { root: '/chosen', project: '/chosen' }), 'prepared')
  active = true
  await assert.rejects(handlers.get('workstep:sandbox:prepare')(event, { root: '/chosen', project: '/chosen' }), /任务/)
})

test('preparation, restart, container health and cleanup preserve project and HOME data', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-lifecycle-'))
  const originalFetch = globalThis.fetch
  try {
    await fs.mkdir(path.join(base, 'project'))
    await fs.writeFile(path.join(base, 'project/source.txt'), 'keep project')
    const calls = []; let running = false, exists = false
    const manager = new SandboxManager({ stateDir: path.join(base, 'state'), platform: 'linux', arch: 'x64', image: 'ghcr.io/test/workstep@sha256:' + 'a'.repeat(64),
      install: async () => ({ executable: '/managed/podman', helpers: [] }), execute: async (_file, args) => {
        calls.push(args)
        if (args.includes('ps')) return exists ? '[{"Id":"owned"}]' : '[]'
        if (args.includes('run')) { running = true; exists = true }
        if (args.includes('stop')) running = false
        if (args.includes('rm')) exists = false
        if (args.includes('port')) return '127.0.0.1:45678'
        return '{}'
      } })
    const status = await manager.prepare({ root: path.join(base, 'sandbox'), project: path.join(base, 'project'), mounts: [] })
    assert.equal(status.settings.enabled, false)
    assert.equal(status.settings.prepared, true)
    await fs.writeFile(path.join(status.settings.root, 'home/engine-data'), 'preserved')
    await manager.setEnabled(true)
    globalThis.fetch = async () => Response.json({ status: 'ok' })
    assert.equal(await manager.start(0, 'token'), 'http://127.0.0.1:45678')
    assert.equal(running, true)
    await manager.stop()
    assert.equal(running, false)
    await manager.start(0, 'new-token')
    assert.equal(await fs.readFile(path.join(status.settings.root, 'home/engine-data'), 'utf8'), 'preserved')
    await manager.stop()
    await manager.setEnabled(false)
    await manager.remove()
    assert.equal(await fs.readFile(path.join(base, 'project/source.txt'), 'utf8'), 'keep project')
    await assert.rejects(fs.stat(status.settings.root))
    assert.ok(calls.some(args => args.includes('pull')))
    assert.ok(calls.some(args => args.includes('rm') && args.includes('owned')))
  } finally { globalThis.fetch = originalFetch; await fs.rm(base, { recursive: true, force: true }) }
})

test('failed image preparation stops only the dedicated VM and remains removable', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-vm-test-'))
  try {
    await fs.mkdir(path.join(base, 'project'))
    let exists = false, running = false
    const calls = []
    const manager = new SandboxManager({ stateDir: path.join(base, 'state'), platform: 'darwin', arch: 'arm64', image: 'ghcr.io/test/workstep@sha256:' + 'a'.repeat(64),
      install: async () => ({ executable: '/managed/podman', helpers: [] }), execute: async (_file, args) => {
        calls.push(args)
        if (args[0] === 'machine' && ['init', 'start'].includes(args[1])) {
          assert.ok(!args.includes('--update-connection=false'), 'Podman 5.6.2 has no update-connection flag')
          assert.ok(!args.includes('--provider=applehv'), 'Podman 5.6.2 selects provider via configuration')
        }
        if (args[0] === 'machine' && args[1] === 'init') exists = true
        if (args[0] === 'machine' && args[1] === 'start') running = true
        if (args[0] === 'machine' && args[1] === 'stop') running = false
        if (args[0] === 'machine' && args[1] === 'list') {
          const settings = (await manager.status()).settings
          return JSON.stringify([{ Name: 'user-existing-machine', Running: true }, ...(exists ? [{ Name: `workstep-${settings.id}`, Running: running }] : [])])
        }
        if (args.includes('pull')) throw new Error('image unavailable')
        return '{}'
      } })
    await assert.rejects(manager.prepare({ root: path.join(base, 'sandbox'), project: path.join(base, 'project'), mounts: [] }), /image unavailable/)
    assert.equal(running, false)
    assert.equal((await manager.status()).settings.enabled, false)
    assert.ok((await manager.status()).settings.root)
    assert.ok(calls.some(args => args.includes('init')))
    const init = calls.find(args => args[0] === 'machine' && args[1] === 'init')
    assert.ok(init.some(arg => arg.endsWith(':/var/mnt/workstep-projects')))
    assert.ok(init.some(arg => arg.endsWith(':/var/mnt/workstep-home')))
    assert.ok(!calls.some(args => args.includes('user-existing-machine')))
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})


test('release manifest refuses floating image tags', () => {
  const { validateImage } = require('../scripts/write-sandbox-release.cjs')
  assert.throws(() => validateImage('ghcr.io/xzregg/workstep:latest'), /immutable/)
  assert.throws(() => validateImage('file:///tmp/image'), /immutable/)
  assert.equal(validateImage('ghcr.io/xzregg/workstep@sha256:' + 'a'.repeat(64)), 'ghcr.io/xzregg/workstep@sha256:' + 'a'.repeat(64))
})

test('desktop packaging rejects a missing sandbox release image', () => {
  const { validateRelease } = require('../scripts/validate-sandbox-release.cjs')
  assert.throws(() => validateRelease({ image: null }), /沙箱镜像/)
  assert.doesNotThrow(() => validateRelease({ image: null, localDocker: true }))
  assert.throws(() => validateRelease({ image: 'ghcr.io/xzregg/workstep:latest' }), /immutable/)
  assert.doesNotThrow(() => validateRelease({ image: 'ghcr.io/xzregg/workstep@sha256:' + 'a'.repeat(64) }))
})

test('container diagnostic logs redact the desktop token', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-log-test-'))
  try {
    await fs.mkdir(path.join(base, 'desktop'))
    const manager = new SandboxManager({ stateDir: path.join(base, 'state') })
    manager.activeConfig = { root: base, id: 'owned' }
    manager.redactions = ['runtime-secret']
    manager.session = { command: async args => { assert.ok(args.includes('workstep-owned')); return 'startup runtime-secret failed' } }
    await manager.captureLogs()
    const logs = await fs.readFile(path.join(base, 'desktop/daemon.log'), 'utf8')
    assert.ok(!logs.includes('runtime-secret'))
    assert.match(logs, /\[redacted\]/)
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('managed gateway uses guest paths on virtualized platforms', () => {
  const managed = { WORKSTEP_MANAGED_BUNDLE_DIR: '/usr/local/share/workstep-managed' }
  for (const [platform, root, source] of [
    ['darwin', '/sandbox', '/var/mnt/workstep-managed'],
    ['win32', 'C:\\sandbox', '/mnt/c/sandbox/desktop/managed-gateway'],
    ['linux', '/sandbox', '/sandbox/desktop/managed-gateway'],
  ]) {
    const args = containerArgs({ root, project: root, mounts: [], id: 'test', image: 'test' }, platform, 0, 'token', managed)
    assert.ok(args.includes(`type=bind,source=${source},target=/usr/local/share/workstep-managed,readonly`))
  }
})


for (const conflict of [false, true]) {
  test(`sandbox prefers fixed port and retries only a bind conflict: ${conflict}`, async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-port-'))
    const originalFetch = globalThis.fetch
    const calls = []
    try {
      await fs.mkdir(path.join(base, 'project'))
      const manager = new SandboxManager({ stateDir: path.join(base, 'state'), platform: 'linux', arch: 'x64', image: 'ghcr.io/test/workstep@sha256:' + 'a'.repeat(64),
        install: async () => ({ executable: '/managed/podman', helpers: [] }), execute: async (_file, args) => {
          calls.push(args)
          if (args.includes('ps')) return '[]'
          if (args.includes('run') && conflict && args.includes('127.0.0.1:8766:8765')) throw new Error('bind: address already in use')
          if (args.includes('port')) return conflict ? '127.0.0.1:45678' : '127.0.0.1:8766'
          return '{}'
        } })
      await manager.prepare({ root: path.join(base, 'sandbox'), project: path.join(base, 'project'), mounts: [] })
      await manager.setEnabled(true)
      globalThis.fetch = async () => Response.json({ status: 'ok' })
      assert.equal(await manager.start(8766, 'token'), conflict ? 'http://127.0.0.1:45678' : 'http://127.0.0.1:8766')
      const runs = calls.filter(args => args.includes('run'))
      assert.equal(runs.length, conflict ? 2 : 1)
      assert.ok(runs[0].includes('127.0.0.1:8766:8765'))
      if (conflict) assert.ok(runs[1].includes('127.0.0.1::8765'))
      await manager.stop()
    } finally { globalThis.fetch = originalFetch; await fs.rm(base, { recursive: true, force: true }) }
  })
}
