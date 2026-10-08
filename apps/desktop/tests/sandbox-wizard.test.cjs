const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { SandboxManager } = require('../src/sandbox.cjs')

test('software and image preparation happen before project selection, cached image survives preparation and migration', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-wizard-'))
  try {
    const root = path.join(base, 'sandbox'), project = path.join(base, 'project'), hostHome = path.join(base, 'host')
    await fs.mkdir(path.join(project, '.workstep'), { recursive: true })
    await fs.writeFile(path.join(project, '.workstep/workstep.db'), 'keep')
    await fs.mkdir(path.join(hostHome, '.workstep'), { recursive: true })
    await fs.writeFile(path.join(hostHome, '.workstep/config.json'), JSON.stringify({ providers: [{ id: 'test', api_key: 'secret' }], projects: [{ path: project, id: 'old-id', name: 'Old' }] }))
    const image = 'ghcr.io/test/workstep@sha256:' + 'a'.repeat(64), calls = []
    const id = 'sha256:' + 'b'.repeat(64)
    const manager = new SandboxManager({ stateDir: path.join(base, 'state'), platform: 'linux', arch: 'x64', hostHome, image,
      install: async () => ({ executable: '/managed/podman', helpers: [] }),
      execute: async (_file, args) => {
        calls.push(args)
        if (args.includes('inspect')) return JSON.stringify([{ Id: id.slice(7), Os: 'linux', Architecture: 'amd64', Config: { Entrypoint: ['/usr/local/bin/workstep-entrypoint'] } }])
        if (args.includes('save')) await fs.writeFile(args[args.indexOf('--output') + 1], 'trusted image archive')
        return ''
      },
    })
    const runtime = await manager.prepareRuntime({ root })
    assert.equal(runtime.runtimeReady, true)
    assert.equal(runtime.settings.project, '')
    const cached = await manager.prepareImage({ root })
    assert.equal(cached.imageReady, true)
    assert.equal(cached.settings.prepared, false)
    const saves = calls.filter(a => a.includes('save')).length
    await manager.prepareImage({ root })
    assert.equal(calls.filter(a => a.includes('save')).length, saves, 'unchanged cache is reused')
    await fs.writeFile(path.join(root, 'podman/cache/image-seed.tar'), 'corrupt archive')
    const settings = { root, project, mounts: [], registeredProjects: [project] }
    await assert.rejects(manager.prepare(settings), /缓存校验/)
    await manager.prepareImage({ root })
    await manager.prepare(settings)
    assert.ok(calls.some(a => a.includes('load')))
    assert.ok(!calls.some(a => a.includes('pull')))
    assert.ok(!calls.some(a => a.includes('rmi') || a.includes('prune')), 'image preparation never removes other images')
    await manager.migrateSettings({ providers: true, engines: true, preferences: true })
    const target = JSON.parse(await fs.readFile(path.join(root, 'home/.workstep/config.json'), 'utf8'))
    assert.equal(target.providers[0].api_key, 'secret')
    assert.equal(target.projects[0].path, '/data/projects')
    assert.equal(target.projects[0].id, 'old-id')
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(hostHome, '.workstep/config.json'), 'utf8')).projects, [{ path: project, id: 'old-id', name: 'Old' }])
    await manager.migrateSettings({ providers: true })
    assert.ok((await fs.readdir(path.join(root, 'desktop/backups'))).length)
    await manager.remove()
    assert.equal(await fs.readFile(path.join(project, '.workstep/workstep.db'), 'utf8'), 'keep')
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('slow runtime work leaves status responsive and prevents overlapping mutations', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-slow-runtime-'))
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  try {
    const manager = new SandboxManager({ stateDir: path.join(base, 'state'), platform: 'linux', arch: 'x64', install: async () => { entered(); await pending; return { executable: '/managed/podman' } } })
    const preparing = manager.prepareRuntime({ root: path.join(base, 'sandbox') })
    await started
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal((await manager.status()).phase, 'download')
    await assert.rejects(manager.prepareRuntime({ root: path.join(base, 'sandbox') }), /正在进行/)
    release(); await preparing
    await manager.remove()
  } finally { release(); await fs.rm(base, { recursive: true, force: true }) }
})

test('partly prepared runtime can be removed without selecting a project', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-partial-'))
  try {
    const root = path.join(base, 'sandbox')
    const manager = new SandboxManager({ stateDir: path.join(base, 'state'), install: async () => { throw new Error('download failed') } })
    await assert.rejects(manager.prepareRuntime({ root }), /download failed/)
    assert.equal((await manager.status()).settings.root, await fs.realpath(root))
    await manager.remove()
    await assert.rejects(fs.stat(root), { code: 'ENOENT' })
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('image inspection normalizes Podman IDs while rejecting incompatible images', async () => {
  const manager = new SandboxManager({ platform: 'darwin', arch: 'arm64' })
  const digest = 'b'.repeat(64)
  const details = { Id: digest, Os: 'linux', Architecture: 'arm64', Config: { Entrypoint: ['/usr/local/bin/workstep-entrypoint'] } }
  const inspect = overrides => manager.inspectImage(async () => JSON.stringify([{ ...details, ...overrides }]), 'local-image')
  assert.equal(await inspect({}), 'sha256:' + digest)
  assert.equal(await inspect({ Id: 'sha256:' + digest }), 'sha256:' + digest)
  await assert.rejects(inspect({ Architecture: 'amd64' }), /架构/)
  await assert.rejects(inspect({ Os: 'windows' }), /系统/)
  await assert.rejects(inspect({ Config: { Entrypoint: ['/bin/sh'] } }), /入口/)
  await assert.rejects(inspect({ Id: 'bad-id' }), /ID/)
})
