const path = require('node:path')
const { isTrustedNavigation } = require('./security.cjs')

function registerSandboxIpc({ ipcMain, dialog, shell, manager, window: getWindow, rootUrl: getRootUrl, hasActiveWork, restart }) {
  const approved = new Set()
  function trusted(event) {
    const window = getWindow()
    if (!window || event.sender !== window.webContents || !isTrustedNavigation(event.senderFrame?.url, getRootUrl())) throw new Error('沙箱操作来源无效')
  }
  async function idle() {
    if (manager.busy || await hasActiveWork() || manager.busy) throw new Error('当前有任务或会话运行，或无法检查状态；请结束工作后重试')
  }
  async function permittedPaths() {
    const existing = (await manager.status()).settings
    const projects = manager.hostProjects ? await manager.hostProjects() : []
    return new Set([existing.root, existing.project, ...(existing.mounts || []).map(m => m.source), ...projects.map(p => p.path), ...approved])
  }
  async function prepareStage(input, method) {
    await idle()
    if (!input?.root || !(await permittedPaths()).has(input.root)) throw new Error('请通过目录选择按钮授权沙箱目录')
    return manager[method](input)
  }
  const handlers = {
    status: () => manager.status(),
    dockerImages: () => manager.dockerImages(),
    hostProjects: () => manager.hostProjects(),
    prepareRuntime: input => prepareStage(input, 'prepareRuntime'),
    prepareImage: input => prepareStage(input, 'prepareImage'),
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled) return null
      const selected = result.filePaths[0]; approved.add(selected); return selected
    },
    prepare: async input => {
      await idle()
      const permitted = await permittedPaths()
      if (!input || ![input.root, input.project, ...(input.mounts || []).map(m => m.source)].every(value => permitted.has(value))) throw new Error('请通过目录选择按钮授权挂载目录')
      if (manager.running) throw new Error('请先关闭沙箱并重启，再修改沙箱设置')
      return manager.prepare(input)
    },
    switchMode: async enabled => {
      await idle()
      const previous = await manager.settings()
      await manager.setEnabled(enabled)
      try { await restart() } catch (error) { await manager.save(previous); throw error }
    },
    importConfig: async kind => { await idle(); return manager.importConfig(kind) },
    migrateSettings: async options => { await idle(); return manager.migrateSettings(options) },
    remove: async () => { await idle(); if (manager.running || (await manager.settings()).enabled) throw new Error('请先关闭沙箱并重启，再删除数据'); return manager.remove() },
    logs: async () => {
      await manager.captureLogs().catch(() => {})
      await manager.logWrite
      const settings = (await manager.status()).settings
      if (settings.root) await shell.openPath(path.join(settings.root, 'desktop'))
    },
  }
  for (const [action, handler] of Object.entries(handlers)) {
    const channel = `workstep:sandbox:${action}`
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, input) => { trusted(event); return handler(input) })
  }
  return handlers
}
module.exports = { registerSandboxIpc }
