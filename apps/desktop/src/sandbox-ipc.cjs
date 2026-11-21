const path = require('node:path')
const { directoryOpeners, openDirectory, fileAction } = require('./directory-openers.cjs')
const { isTrustedNavigation } = require('./security.cjs')
const { resolveDroppedDirectory } = require('./project-drop.cjs')

function registerSandboxIpc({ ipcMain, dialog, shell, clipboard, manager, window: getWindow, rootUrl: getRootUrl, hasActiveWork, restart }) {
  const approved = new Set()
  const configDirectories = new Set()
  function trusted(event) {
    const window = getWindow()
    if (!window || event.sender !== window.webContents || !isTrustedNavigation(event.senderFrame?.url, getRootUrl())) throw new Error('Invalid sandbox operation source')
  }
  async function idle() {
    if (manager.busy || await hasActiveWork() || manager.busy) throw new Error('A task or session is currently running, or the status cannot be checked; please retry after ending the work.')
  }
  async function permittedPaths() {
    const existing = (await manager.status()).settings
    const projects = manager.hostProjects ? await manager.hostProjects() : []
    return new Set([existing.root, existing.project, ...(existing.mounts || []).map(m => m.source), ...projects.map(p => p.path), ...approved])
  }
  async function prepareStage(input, method) {
    if (manager.busy) throw new Error('Sandbox operation in progress, please try again later')
    if (manager.running) throw new Error('Please close the sandbox and restart, then prepare the auxiliary software or image')
    if (!input?.root || !(await permittedPaths()).has(input.root)) throw new Error('Please authorize the sandbox directory via the directory selection button')
    return manager[method](input)
  }
  const handlers = {
    droppedDirectory: input => resolveDroppedDirectory(input, manager),
    status: () => manager.status(),
    directoryOpeners: async () => ({ openers: await directoryOpeners() }),
    openDirectory: input => openDirectory(input, manager, shell),
    fileAction: input => fileAction(input, manager, shell, dialog, getWindow()),
    dockerImages: () => manager.dockerImages(),
    hostProjects: () => manager.hostProjects(),
    prepareRuntime: input => prepareStage(input, 'prepareRuntime'),
    prepareImage: input => prepareStage(input, 'prepareImage'),
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled) return null
      const selected = result.filePaths[0]; approved.add(selected); return selected
    },
    chooseConfigDirectory: async () => {
      const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'showHiddenFiles'] })
      if (result.canceled) return null
      const source = result.filePaths[0]
      if (!source) return null
      configDirectories.add(source)
      return { source, name: path.basename(source) }
    },
    prepare: async input => {
      await idle()
      const permitted = await permittedPaths()
      if (!input || ![input.root, input.project, ...(input.mounts || []).map(m => m.source)].every(value => permitted.has(value))) throw new Error('Please authorize the mount directory via the directory selection button')
      if (manager.running) throw new Error('Please close the sandbox and restart, then modify the sandbox settings')
      return manager.prepare(input)
    },
    switchMode: async enabled => {
      await idle()
      const previous = await manager.settings()
      await manager.setEnabled(enabled)
      try { await restart() } catch (error) { await manager.save(previous); throw error }
    },
    switchImage: async image => {
      await idle()
      const available = await manager.dockerImages()
      if (available.error) throw new Error(available.error)
      const selected = available.images.find(item => item.id === image)
      if (!selected) throw new Error('Please select a compatible image from the scan results')
      await manager.queueImageSwitch(image, selected.tags[0] || null)
      await restart()
    },
    importConfig: async input => {
      await idle()
      if (typeof input !== 'string' && !configDirectories.has(input?.source)) throw new Error('Please authorize the configuration source via the directory selection button')
      return manager.importConfig(input)
    },
    migrateSettings: async options => { await idle(); return manager.migrateSettings(options) },
    remove: async () => { await idle(); if (manager.running || (await manager.settings()).enabled) throw new Error('Please close the sandbox and restart, then delete the data'); return manager.remove() },
    logs: async () => {
      await manager.captureLogs().catch(() => {})
      await manager.logWrite
      const settings = (await manager.status()).settings
      if (settings.root) await shell.openPath(path.join(settings.root, 'desktop'))
    },
    readLogs: () => manager.readLogs(),
    copyLogs: async () => { clipboard.writeText(await manager.readLogs()) },
  }
  for (const [action, handler] of Object.entries(handlers)) {
    const channel = `workstep:sandbox:${action}`
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, input) => { trusted(event); return handler(input) })
  }
  return handlers
}
module.exports = { registerSandboxIpc }
