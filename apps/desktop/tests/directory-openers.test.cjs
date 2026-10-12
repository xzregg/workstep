const test = require('node:test')
const assert = require('node:assert/strict')
const { mapSandboxPath, directoryOpeners, openCommand, openDirectory, fileAction } = require('../src/directory-openers.cjs')
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

test('file actions preserve the file, reveal it, and save a complete copy through the native dialog', async () => {
 const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-file-'))
 const file = path.join(root, 'source.txt'), destination = path.join(root, 'saved.txt')
 const opened = [], revealed = []
 const manager = { status: async () => ({ running: true, settings: { root: '/sandbox', project: root } }) }
 const shell = { openPath: async value => { opened.push(value); return '' }, showItemInFolder: value => revealed.push(value) }
 try {
  await fs.writeFile(file, 'complete content')
  await fileAction({ path: '/data/projects/source.txt', action: 'open', opener: 'default' }, manager, shell)
  await fileAction({ path: '/data/projects/source.txt', action: 'reveal' }, manager, shell)
  assert.deepEqual(opened, [await fs.realpath(file)])
  assert.deepEqual(revealed, opened)
  await fileAction({ path: '/data/projects/source.txt', action: 'save' }, manager, shell,
   { showSaveDialog: async () => ({ canceled: false, filePath: destination }) })
  assert.equal(await fs.readFile(destination, 'utf8'), 'complete content')
  await assert.rejects(fileAction({ path: '/etc/passwd', action: 'open' }, manager, shell), /挂载/)
 } finally { await fs.rm(root, { recursive: true, force: true }) }
})
