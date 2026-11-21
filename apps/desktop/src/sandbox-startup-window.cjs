const path = require('node:path')
const fs = require('node:fs')

const LABELS = {
  download: '正在下载沙箱运行环境', machine: '正在启动 Podman 虚拟机',
  image: '正在准备 WorkStep 镜像', caching: '正在缓存 WorkStep 镜像',
  switching: '正在切换 WorkStep 镜像',
  starting: '正在启动 WorkStep 容器', running: '沙箱后台已启动',
  error: 'Sandbox startup failed', idle: '正在检查沙箱配置', ready: '沙箱已准备就绪',
}
const PHASE_PROGRESS = { idle: 5, switching: 10, download: 5, machine: 30, image: 45, caching: 55, ready: 65, starting: 70, running: 100 }
const PHASE_STEP = {
  idle: 'config', download: 'config', runtimeReady: 'config', machine: 'machine',
  image: 'image', switching: 'image', caching: 'image', imageReady: 'image', ready: 'image',
  starting: 'container', running: 'container',
}
const RECOVERY_ACTIONS = new Set(['retry', 'withoutSandbox', 'quit'])

function startupViewState(status = {}) {
  let progress = Number.isFinite(status.percent) ? status.percent : PHASE_PROGRESS[status.phase]
  if (status.phase === 'download' && status.progress?.total) {
    progress = 5 + Math.round(status.progress.received / status.progress.total * 15)
  }
  if (status.phase === 'error') progress = null
  if (Number.isFinite(progress)) progress = Math.max(0, Math.min(100, Math.round(progress)))
  else progress = null
  return { phase: status.phase || 'idle', label: status.message || LABELS[status.phase] || '正在准备沙箱', progress, error: status.error || null }
}

function formatSandboxFailure(error, status = {}) {
  const phase = startupViewState(status).label
  const lines = [error instanceof Error ? error.message : String(error), '', `Stage: ${status.phase || phase}`]
  if (status.hostPort) lines.push(`Backend port: ${status.hostPort}`)
  if (status.logDirectory) lines.push(`Log directory: ${status.logDirectory}`)
  return lines.join('\n')
}

async function applyPendingImageSwitch(manager) {
  const settings = await manager.settings()
  if (!settings.pendingDockerImage) return false
  if (settings.enabled) await manager.setEnabled(false)
  try {
    let dockerImage = settings.pendingDockerImage
    if (settings.pendingDockerImageTag) {
      const available = await manager.dockerImages()
      if (available.error) throw new Error(available.error)
      const replacement = available.images.find(item => item.tags.includes(settings.pendingDockerImageTag))
      if (replacement) dockerImage = replacement.id
    }
    const {
      pendingDockerImage: _pendingImage,
      pendingDockerImageTag: _pendingTag,
      registeredProjects: _registeredProjects,
      ...nextSettings
    } = settings
    // A local Docker image is imported directly by prepare(). Avoid creating
    // and hashing a second OCI cache only to load it again in the next step.
    // Keep the VM warm so start() can launch the container immediately.
    await manager.prepare({ ...nextSettings, dockerImage, keepMachineRunning: true })
    await manager.setEnabled(true)
    return true
  } catch (error) {
    if (settings.enabled) await manager.setEnabled(true)
    throw error
  }
}

function createSandboxStartupWindow(BrowserWindow, { onUserClose, image, iconDataUrl } = {}) {
  const window = new BrowserWindow({
    title: 'WorkStep 沙箱启动', width: 560, height: 680, minWidth: 480, minHeight: 520,
    show: false, resizable: true, backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'sandbox-startup-preload.cjs') },
  })
  let state = startupViewState()
  let step = 'config'
  let recovery
  let loaded = false
  let closingInternally = false
  function publish() {
    if (loaded && !window.isDestroyed()) {
      window.webContents.send('workstep:sandbox:startupStatus', {
        ...state, step, image, recovery: Boolean(recovery),
      })
    }
  }
  function update(status) {
    state = startupViewState(status)
    step = PHASE_STEP[state.phase] || step
    publish()
  }
  window.on('close', event => {
    if (!closingInternally) onUserClose?.(event, window)
  })
  window.webContents.once('did-finish-load', () => { loaded = true; publish() })
  window.once('ready-to-show', () => window.show())
  const logo = /^data:image\/png;base64,[\w+/=]+$/.test(iconDataUrl ?? '')
    ? `<img alt="" src="${iconDataUrl}">` : ''
  const markup = fs.readFileSync(path.join(__dirname, 'sandbox-startup.html'), 'utf8').replace('<!--APP_ICON-->', logo)
  void window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(markup)}`)
  return {
    window,
    update,
    setImage(value) { image = value; publish() },
    waitForRecovery(status) {
      return new Promise(resolve => {
        recovery = resolve
        update(status)
      })
    },
    recover(action) {
      if (!recovery || !RECOVERY_ACTIONS.has(action)) return false
      const resolve = recovery
      recovery = undefined
      update({ phase: 'idle' })
      resolve(action)
      return true
    },
    close() {
      closingInternally = true
      if (!window.isDestroyed()) window.close()
    },
  }
}

module.exports = { createSandboxStartupWindow, formatSandboxFailure, startupViewState, applyPendingImageSwitch }
