const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { SandboxManager } = require('../src/sandbox.cjs')
const { ensureMachineDisk, storageError } = require('../src/sandbox-storage.cjs')

test('existing dedicated macOS VM grows without deleting its containers or images', async () => {
  const calls = []
  await ensureMachineDisk(async args => {
    calls.push(args)
    return JSON.stringify([{ Resources: { DiskSize: 20 } }])
  }, 'workstep-test', true)
  assert.deepEqual(calls, [
    ['machine', 'inspect', 'workstep-test'],
    ['machine', 'stop', 'workstep-test'],
    ['machine', 'set', '--disk-size=64', 'workstep-test'],
  ])
})

test('larger VMs are never shrunk and stopped VMs need no stop', async () => {
  for (const size of [20, 64, 100]) {
    const calls = []
    await ensureMachineDisk(async args => { calls.push(args); return JSON.stringify([{ Resources: { DiskSize: size } }]) }, 'owned', false)
    assert.equal(calls.some(args => args.includes('stop')), false)
    assert.equal(calls.some(args => args.includes('set')), size < 64)
  }
})

test('failed disk resize preserves the VM and reports an actionable error', async () => {
  const calls = []
  await assert.rejects(ensureMachineDisk(async args => {
    calls.push(args)
    if (args.includes('set')) throw new Error('resize failed')
    return JSON.stringify([{ Resources: { DiskSize: 20 } }])
  }, 'owned', false), /扩容.*64.*resize failed/)
  assert.ok(!calls.some(args => args.includes('rm') || args.includes('init')))
})

test('ENOSPC explains the Podman disk rather than claiming an unsupported archive', () => {
  const original = new Error('payload does not match any supported image formats: writing blob: no space left on device')
  const error = storageError(original, 'darwin')
  assert.match(error.message, /Podman.*空间不足/)
  assert.match(error.message, /Docker.*不会/)
  assert.equal(error.cause, original)
  assert.match(storageError(original, 'linux').message, /所在磁盘/)
  const unrelated = new Error('invalid manifest')
  assert.equal(storageError(unrelated, 'darwin'), unrelated)
})

test('setup migrates only its existing VM before starting and translates load errors', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-storage-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const config = { root: path.join(await fs.realpath(base), 'sandbox'), id: 'owned', project: '', mounts: [] }
  const calls = []
  let running = true, diskSize = 20
  const manager = new SandboxManager({ stateDir: path.join(base, 'state'), platform: 'darwin', arch: 'arm64',
    install: async () => ({ executable: '/managed/podman', helpers: [] }),
    execute: async (_file, args) => {
      calls.push(args)
      if (args[0] === 'machine') {
        if (args[1] === 'list') return JSON.stringify([{ Name: 'workstep-owned', Running: running }, { Name: 'unrelated', Running: true }])
        if (args[1] === 'inspect') return JSON.stringify([{ Resources: { DiskSize: diskSize } }])
        if (args[1] === 'stop') running = false
        if (args[1] === 'set') diskSize = 64
        if (args[1] === 'start') { assert.equal(diskSize, 64); running = true }
      }
      if (args.includes('load')) throw new Error('oci-archive: writing blob: no space left on device')
      return '{}'
    },
  })
  await manager.claimRoot(config)
  await fs.writeFile(path.join(config.root, 'desktop/machine-mounts.json'), JSON.stringify({ layout: 2, project: '', mounts: [] }))
  const session = await manager.setup(config)
  assert.deepEqual(calls.filter(a => a[0] === 'machine').map(a => a[1]), ['list', 'inspect', 'stop', 'set', 'list', 'start'])
  assert.ok(!calls.some(a => a.includes('unrelated') || a.includes('rm') || a.includes('prune')))
  await assert.rejects(session.command(['load', '--input', '/image.tar']), /Podman.*空间不足/)
  calls.length = 0
  await manager.setup(config)
  assert.ok(!calls.some(a => a.includes('stop') || a.includes('set') || a.includes('start')), 'subsequent setup leaves an adequate running VM alone')
})
