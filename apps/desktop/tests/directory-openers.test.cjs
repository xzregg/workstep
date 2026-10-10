const test = require('node:test')
const assert = require('node:assert/strict')
const { mapSandboxPath, directoryOpeners, openCommand, openDirectory } = require('../src/directory-openers.cjs')
test('container paths map by longest mount boundary', () => {
 const config = { root: '/sandbox', project: '/projects', mounts: [{ source: '/extra', target: '/data/projects/extra' }] }
 assert.equal(mapSandboxPath('/data/projects/a', config), '/projects/a')
 assert.equal(mapSandboxPath('/data/projects/extra/a', config), '/extra/a')
 assert.equal(mapSandboxPath('/root/.workstep', config), '/sandbox/home/.workstep')
 assert.throws(() => mapSandboxPath('/data/projects-other', config))
 assert.throws(() => mapSandboxPath('/data/projects/../../etc', config))
})
test('host applications are detected and launched without shell interpolation', async () => {
 const openers = await directoryOpeners({ platform: 'darwin', exists: async p => p === '/Applications/Visual Studio Code.app' })
 assert.equal(openers.find(o => o.id === 'vscode').available, true)
 assert.equal(openers.find(o => o.id === 'iterm').available, false)
 assert.deepEqual(openCommand('darwin', 'vscode', '/projects/a $()'), ['open', '-a', 'Visual Studio Code', '/projects/a $()'])
 assert.throws(() => openCommand('darwin', 'unknown', '/projects'))
})

test('opening a sandbox directory hands the mapped host directory to Electron', async () => {
 const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-open-'))
 const opened = []
 try {
  await fs.mkdir(path.join(root, 'demo'))
  const result = await openDirectory({ path: '/data/projects/demo', opener: 'file_manager' },
   { status: async () => ({ running: true, settings: { root: '/sandbox', project: root, mounts: [] } }) },
   { openPath: async directory => { opened.push(directory); return '' } })
  assert.deepEqual(opened, [await fs.realpath(path.join(root, 'demo'))])
  assert.equal(result.opened, true)
  await assert.rejects(openDirectory({ path: '/etc', opener: 'file_manager' },
   { status: async () => ({ running: true, settings: { root: '/sandbox', project: root, mounts: [] } }) },
   { openPath: async () => { throw new Error('must not open') } }), /挂载/)
 } finally { await fs.rm(root, { recursive: true, force: true }) }
})
