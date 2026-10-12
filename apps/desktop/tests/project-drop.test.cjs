const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { resolveDroppedDirectory } = require('../src/project-drop.cjs')

test('drop resolves directory aliases and rejects ordinary files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-drop-'))
  try {
    await fs.mkdir(path.join(root, 'project'))
    await fs.symlink(path.join(root, 'project'), path.join(root, 'alias'))
    await fs.writeFile(path.join(root, 'file.txt'), 'test')
    assert.equal(await resolveDroppedDirectory(path.join(root, 'alias')), await fs.realpath(path.join(root, 'project')))
    await assert.rejects(resolveDroppedDirectory(path.join(root, 'file.txt')), /文件夹/)
    await assert.rejects(resolveDroppedDirectory('relative'), /绝对路径/)
    await assert.rejects(resolveDroppedDirectory(path.join(root, 'missing')))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('sandbox maps host folder into the active mount and rejects unmounted folders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-drop-'))
  try {
    await fs.mkdir(path.join(root, 'nested'))
    const manager = { running: true, activeConfig: { project: root, mounts: [{ source: path.join(root, 'nested'), target: '/data/projects/extra' }] } }
    assert.equal(await resolveDroppedDirectory(path.join(root, 'nested'), manager), '/data/projects/extra')
    assert.equal(await resolveDroppedDirectory(root, manager), '/data/projects')
    await assert.rejects(resolveDroppedDirectory(os.tmpdir(), manager), /挂载/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('preload obtains the native File path via webUtils and invokes the directory bridge', async () => {
  const vm = require('node:vm')
  let exposed
  const file = { name: 'folder' }
  const calls = []
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value } },
    webUtils: { getPathForFile: input => { assert.equal(input, file); return '/native/folder' } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return '/native/folder' } },
  }
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../src/preload.cjs'), 'utf8'), { require: () => electron, process })
  assert.equal(exposed.projects.pathForFile(file), '/native/folder')
  assert.equal(await exposed.projects.resolveDirectory('/native/folder'), '/native/folder')
  assert.deepEqual(calls, [['workstep:sandbox:droppedDirectory', '/native/folder']])
})

test('directory IPC accepts only the trusted local workspace', async () => {
  const { registerSandboxIpc } = require('../src/sandbox-ipc.cjs')
  const handlers = new Map()
  const webContents = {}
  registerSandboxIpc({ ipcMain: { removeHandler() {}, handle: (channel, handler) => handlers.set(channel, handler) },
    manager: { running: false }, window: () => ({ webContents }), rootUrl: () => 'http://127.0.0.1:8765' })
  const invoke = handlers.get('workstep:sandbox:droppedDirectory')
  await assert.rejects(invoke({ sender: webContents, senderFrame: { url: 'https://external.test' } }, os.tmpdir()), /来源/)
  await assert.rejects(invoke({ sender: {}, senderFrame: { url: 'http://127.0.0.1:8765/' } }, os.tmpdir()), /来源/)
  assert.equal(await invoke({ sender: webContents, senderFrame: { url: 'http://127.0.0.1:8765/' } }, os.tmpdir()), await fs.realpath(os.tmpdir()))
})
