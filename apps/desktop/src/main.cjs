const path = require('node:path')
const { app, BrowserWindow, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')
const {
  backendExecutable,
  protocolPath,
  resolveBackendPort,
  startSidecar,
  stopSidecar,
} = require('./sidecar.cjs')

let backendProcess = null
let stopping = null
let installingUpdate = false
let mainWindow = null
let rootUrl = null
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
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
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
  const result = await startSidecar({
    executable: backendExecutable(process.resourcesPath),
    port: requestedPort,
  })
  backendProcess = result.child
  return `http://127.0.0.1:${result.port}`
}

function configureUpdater() {
  if (!app.isPackaged) return
  if (process.platform === 'darwin') {
    autoUpdater.channel = `latest-${process.arch}`
  }
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('update-downloaded', async () => {
    installingUpdate = true
    await stopBackend()
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 500)
  })
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
