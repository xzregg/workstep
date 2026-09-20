const { randomBytes } = require('node:crypto')
const { app, BrowserWindow, dialog, session, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const {
  backendLaunch,
  protocolPath,
  resolveBackendPort,
  startSidecar,
  stopSidecar,
} = require('./sidecar.cjs')
const {
  isAllowedExternalUrl,
  isTrustedNavigation,
  projectsHaveActiveWork,
  sessionsHaveActiveWork,
} = require('./security.cjs')

let backendProcess = null
let stopping = null
let installingUpdate = false
let mainWindow = null
let rootUrl = null
let desktopToken = null
let pendingProtocolUrl = process.argv.find((value) => value.startsWith('workstep://')) ?? null

function openProtocolUrl(value) {
  pendingProtocolUrl = value
  if (!mainWindow || !rootUrl) return
  try {
    void mainWindow.loadURL(`${rootUrl}${protocolPath(value)}`)
  } catch (error) {
    console.error('Ignoring invalid WorkStep URL', error)
  }
}

async function stopBackend() {
  if (!stopping) {
    stopping = stopSidecar(backendProcess).finally(() => {
      backendProcess = null
    })
  }
  await stopping
}

function createWindow(url) {
  process.env.WORKSTEP_BACKEND_URL = url
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (isTrustedNavigation(targetUrl, rootUrl)) return
    event.preventDefault()
    if (isAllowedExternalUrl(targetUrl)) void shell.openExternal(targetUrl)
  })
  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isAllowedExternalUrl(targetUrl)) void shell.openExternal(targetUrl)
    return { action: 'deny' }
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  void window.loadURL(url)
  mainWindow = window
  return window
}

async function backendUrl() {
  const requestedPort = resolveBackendPort()
  if (!app.isPackaged) {
    return process.env.WORKSTEP_DEV_SERVER_URL
      ?? `http://127.0.0.1:${requestedPort || 8765}`
  }
  const launch = backendLaunch(process.resourcesPath)
  desktopToken = randomBytes(32).toString('hex')
  const result = await startSidecar({
    ...launch,
    port: requestedPort,
    env: {
      ...process.env,
      WORKSTEP_DESKTOP_RUNTIME: '1',
      WORKSTEP_DESKTOP_TOKEN: desktopToken,
    },
  })
  backendProcess = result.child
  return `http://127.0.0.1:${result.port}`
}

function configureAuthenticatedRequests(url) {
  if (!desktopToken) return
  const parsed = new URL(url)
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  const filter = {
    urls: [
      `${parsed.origin}/*`,
      `${wsProtocol}//${parsed.host}/*`,
    ],
  }
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    details.requestHeaders['X-WorkStep-Desktop-Token'] = desktopToken
    callback({ requestHeaders: details.requestHeaders })
  })
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}

async function hasActiveWork() {
  if (!rootUrl || !desktopToken) return true
  try {
    const response = await fetch(`${rootUrl}/api/project/list`, {
      headers: { 'X-WorkStep-Desktop-Token': desktopToken },
    })
    if (!response.ok) return true
    const projectsPayload = await response.json()
    if (projectsHaveActiveWork(projectsPayload)) return true
    for (const project of projectsPayload.projects) {
      if (!project?.id || project?.type === 'remote') continue
      const sessionsResponse = await fetch(
        `${rootUrl}/api/chat-sessions?project_id=${encodeURIComponent(project.id)}`,
        { headers: { 'X-WorkStep-Desktop-Token': desktopToken } },
      )
      if (!sessionsResponse.ok || sessionsHaveActiveWork(await sessionsResponse.json())) return true
    }
    return false
  } catch (error) {
    console.error('Unable to verify active work before update', error)
    return true
  }
}

async function promptForUpdateInstall() {
  const active = await hasActiveWork()
  if (active) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'WorkStep 更新已下载',
      message: '更新将在稍后安装',
      detail: '当前仍有任务或会话运行。请结束工作后重启 WorkStep，以免中断正在写入的数据。',
      buttons: ['知道了'],
    })
    return
  }
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'WorkStep 更新已下载',
    message: '是否立即重启并安装更新？',
    detail: '也可以选择稍后，在退出 WorkStep 后再安装。',
    buttons: ['稍后', '立即重启并安装'],
    defaultId: 1,
    cancelId: 0,
  })
  if (result.response !== 1) return
  installingUpdate = true
  await stopBackend()
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 500)
}

function configureUpdater() {
  if (!app.isPackaged) return
  if (process.platform === 'darwin') {
    autoUpdater.channel = `latest-${process.arch}`
  }
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', () => void promptForUpdateInstall())
  autoUpdater.on('error', (error) => console.error('Auto update failed', error))
  void autoUpdater.checkForUpdatesAndNotify()
}

app.on('before-quit', (event) => {
  if (installingUpdate || !backendProcess) return
  event.preventDefault()
  void stopBackend().then(() => app.quit())
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', (_event, argv) => {
  const value = argv.find((argument) => argument.startsWith('workstep://'))
  if (value) openProtocolUrl(value)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('open-url', (event, value) => {
  event.preventDefault()
  openProtocolUrl(value)
})

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  try {
    rootUrl = await backendUrl()
    configureAuthenticatedRequests(rootUrl)
    const initialPath = pendingProtocolUrl ? protocolPath(pendingProtocolUrl) : '/'
    createWindow(`${rootUrl}${initialPath}`)
    configureUpdater()
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'WorkStep 无法启动',
      message: '本地后台服务启动失败',
      detail: error instanceof Error ? error.message : String(error),
    })
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
