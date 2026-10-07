const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { listDockerImages, importDockerImage } = require('../src/sandbox-docker.cjs')
const id = 'sha256:' + 'a'.repeat(64)
test('local Docker scan filters incompatible images and retains immutable IDs', async () => {
  const execute = async (_file, args) => args[0] === 'image' && args[1] === 'ls' ? id : JSON.stringify([{ Id: id, Os: 'linux', Architecture: 'arm64', RepoTags: ['workstep:latest'], Config: { Entrypoint: ['/usr/local/bin/workstep-entrypoint'] } }])
  assert.equal((await listDockerImages(execute, 'darwin', 'arm64')).images[0].id, id)
  assert.equal((await listDockerImages(execute, 'darwin', 'x64')).images.length, 0)
})
test('Docker import saves by ID, verifies Podman identity and removes temporary archives', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-docker-'))
  const calls = []
  const importedId = 'sha256:' + createHash('sha256').update('{}').digest('hex')
  const execute = async (_file, args) => {
    calls.push(args)
    if (args[0] === '-xOf') return JSON.stringify([{ Config: 'config.json' }])
    if (args[0] === '-xf') await fs.writeFile(path.join(args[3], 'config.json'), '{}')
    if (args[1] === 'inspect') return JSON.stringify([{ Id: id, Os: 'linux', Architecture: 'arm64', Config: { Entrypoint: ['/usr/local/bin/workstep-entrypoint'] } }])
    if (args[0] === 'save') await fs.writeFile(args[2], 'archive')
  }
  try {
    assert.equal(await importDockerImage({ root, id, execute, platform: 'darwin', arch: 'arm64', command: async args => { calls.push(args); return args[1] === 'inspect' ? importedId.slice(7) : '' } }), importedId)
    assert.ok(calls.some(args => args[0] === 'save' && args[3] === id))
    assert.ok(calls.some(args => args[0] === 'load'))
    assert.deepEqual(await fs.readdir(path.join(root, 'desktop')), [])
    await assert.rejects(importDockerImage({ root, id: '--bad', execute }), /镜像 ID/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
