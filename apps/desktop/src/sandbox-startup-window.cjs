const path = require('node:path')
const fs = require('node:fs')

const LABELS = {
  download: '正在下载沙箱运行环境', machine: '正在启动 Podman 虚拟机',
  image: '正在准备 WorkStep 镜像', caching: '正在缓存 WorkStep 镜像',
  starting: '正在启动 WorkStep 容器', running: '沙箱后台已启动',
  error: '沙箱启动失败', idle: '正在检查沙箱配置', ready: '沙箱已准备就绪',
}
const PHASE_PROGRESS = { idle: 5, download: 5, machine: 30, image: 45, caching: 55, ready: 65, starting: 70, running: 100 }

function startupViewState(status = {}) {
  let progress = Number.isFinite(status.percent) ? status.percent : PHASE_PROGRESS[status.phase]
  if (status.phase === 'download' && status.progress?.total) {
    progress = 5 + Math.round(status.progress.received / status.progress.total * 15)
  }
  if (status.phase === 'error') progress = null
  if (Number.isFinite(progress)) progress = Math.max(0, Math.min(100, Math.round(progress)))
  else progress = null
  return { phase: status.phase || 'idle', label: LABELS[status.phase] || '正在准备沙箱', progress, error: status.error || null }
}

function formatSandboxFailure(error, status = {}) {
  const phase = startupViewState(status).label
  const lines = [error instanceof Error ? error.message : String(error), '', `当前阶段：${phase}`]
  if (status.hostPort) lines.push(`后台端口：${status.hostPort}`)
  if (status.logDirectory) lines.push(`日志目录：${status.logDirectory}`)
  return lines.join('\n')
}

async function applyPendingImageSwitch(manager) {
  const settings = await manager.settings()
  if (!settings.pendingDockerImage) return false
  let dockerImage = settings.pendingDockerImage
  try {
    await manager.prepareImage({ root: settings.root, dockerImage })
  } catch (error) {
    if (!settings.pendingDockerImageTag || !/no such image|image not known|not found/i.test(error instanceof Error ? error.message : String(error))) throw error
    const available = await manager.dockerImages()
    const replacement = available.images.find(item => item.tags.includes(settings.pendingDockerImageTag))
    if (!replacement) throw error
    dockerImage = replacement.id
    await manager.prepareImage({ root: settings.root, dockerImage })
  }
  const {
    pendingDockerImage: _pendingImage,
    pendingDockerImageTag: _pendingTag,
    registeredProjects: _registeredProjects,
    ...nextSettings
  } = settings
  await manager.prepare({ ...nextSettings, dockerImage })
  await manager.setEnabled(true)
  return true
}

function createSandboxStartupWindow(BrowserWindow, { onUserClose } = {}) {
  const window = new BrowserWindow({
    title: 'WorkStep 沙箱启动', width: 560, height: 680, minWidth: 480, minHeight: 520,
    show: false, resizable: true, backgroundColor: '#f7f8fa',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'sandbox-startup-preload.cjs') },
  })
  let state = startupViewState()
  let loaded = false
  let closingInternally = false
  window.on('close', event => {
    if (!closingInternally) onUserClose?.(event, window)
  })
  window.webContents.once('did-finish-load', () => { loaded = true; window.webContents.send('workstep:sandbox:startupStatus', state) })
  window.once('ready-to-show', () => window.show())
  const markup = fs.readFileSync(path.join(__dirname, 'sandbox-startup.html'), 'utf8')
  void window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(markup)}`)
  return {
    window,
    update(status) { state = startupViewState(status); if (loaded && !window.isDestroyed()) window.webContents.send('workstep:sandbox:startupStatus', state) },
    close() {
      closingInternally = true
      if (!window.isDestroyed()) window.close()
    },
  }
}

module.exports = { createSandboxStartupWindow, formatSandboxFailure, startupViewState, applyPendingImageSwitch }
