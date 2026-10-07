const { createPrivateKey, randomBytes, sign } = require('node:crypto')
const { app, BrowserWindow, Notification, dialog, ipcMain, safeStorage, session, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { SandboxManager } = require('./sandbox.cjs')
const { registerSandboxIpc } = require('./sandbox-ipc.cjs')
const { autoUpdater } = require('electron-updater')
const { managedEnvironment, readManagedConfig } = require('./managed-config.cjs')
const { loadOrCreateDeviceIdentity } = require('./credential-store.cjs')
const { managedSessionExpired } = require('./managed-session.cjs')
const {
  createAuthorizationRequest, claimAuthCallback, exchangeDesktopCode,
  createControlDelegation,
} = require('./desktop-auth.cjs')
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
  updaterChannel,
} = require('./security.cjs')

let sandboxManager = null
let backendProcess = null
let stopping = null
let installingUpdate = false
let mainWindow = null
let rootUrl = null
let desktopToken = null
let localSession = null
let managedPending = null
let managedCallbackResolve = null
let managedCallbackTimeout = null
let reauthenticating = null
let controlStatusTimer = null
let pendingProtocolUrl = process.argv.find((value) => value.startsWith('workstep://')) ?? null

function openProtocolUrl(value) {
  if (value.startsWith('workstep://auth/')) {
    if (!managedPending || !managedCallbackResolve) return
    try {
      const callback = claimAuthCallback(value, managedPending)
      clearTimeout(managedCallbackTimeout)
      managedCallbackResolve(callback)
      managedCallbackResolve = null
    } catch (error) {
      console.error('Ignoring invalid WorkStep auth callback', error)
    }
    return
  }
  pendingProtocolUrl = value
  if (!mainWindow || !rootUrl) return
  try {
    void mainWindow.loadURL(`${rootUrl}${protocolPath(value)}`)
  } catch (error) {
    console.error('Ignoring invalid WorkStep URL', error)
  }
}

async function authorizeManagedDesktop(managed) {
  const identity = await loadOrCreateDeviceIdentity(app.getPath('userData'), safeStorage, managed.gateway_id)
  const pending = createAuthorizationRequest(managed, identity.appInstanceId)
  managedPending = pending
  const callbackPromise = new Promise((resolve, reject) => {
    managedCallbackResolve = resolve
    managedCallbackTimeout = setTimeout(() => {
      managedCallbackResolve = null
      reject(new Error('Gateway login timed out'))
    }, 5 * 60 * 1000)
  })
  let callback
  try {
    await shell.openExternal(pending.authorizationUrl)
    callback = await callbackPromise
  } finally {
    clearTimeout(managedCallbackTimeout)
    managedCallbackResolve = null
    managedPending = null
  }
  const result = await exchangeDesktopCode({
    pending, code: callback.code, managed,
    devicePublicKey: identity.publicKeyPem,
    deviceName: require('node:os').hostname(), version: app.getVersion(),
    os: { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform],
    arch: ['arm64', 'x64'].includes(process.arch) ? process.arch : undefined,
  })
  if (!result.device_authorization) {
    await dialog.showMessageBox({
      type: 'info', title: 'WorkStep 设备待审批',
      message: '管理员批准此设备后，请重新打开 WorkStep 完成登录。',
      buttons: ['知道了'],
    })
    return null
  }
  const proof = sign(null, Buffer.from(result.device_authorization),
    createPrivateKey(identity.privateKeyPem)).toString('base64url')
  return { authorization: result.device_authorization, proof,
    ...createControlDelegation(result.device_authorization, identity.privateKeyPem) }
}

async function bootstrapManagedBackend(url, authorization) {
  const response = await fetch(`${url}/api/managed/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorkStep-Desktop-Token': desktopToken },
    body: JSON.stringify({ device_authorization: authorization.authorization,
      device_proof: authorization.proof,
      control_private_key_pem: authorization.controlPrivateKeyPem,
      control_public_key_pem: authorization.controlPublicKeyPem,
      control_delegation_signature: authorization.delegationSignature }),
  })
  if (!response.ok) throw new Error(`Managed backend rejected device authorization (${response.status})`)
  const result = await response.json()
  if (!result.local_session) throw new Error('Managed backend returned no local session')
  localSession = result.local_session
}

async function stopBackend() {
  if (!stopping) {
    stopping = (async () => {
      if (sandboxManager?.session) await sandboxManager.stop()
      await stopSidecar(backendProcess)
    })().finally(() => {
      backendProcess = null
      stopping = null
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
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
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
  ipcMain.removeAllListeners('workstep:notify')
  ipcMain.on('workstep:notify', (event, notice) => {
    if (window.isDestroyed() || window.isFocused()) return
    if (event.sender !== window.webContents || !isTrustedNavigation(event.senderFrame?.url, rootUrl)) return
    if (!notice || typeof notice !== 'object' ||
        !['succeeded', 'failed'].includes(notice.outcome) ||
        typeof notice.url !== 'string' || !notice.url.startsWith('/') ||
        !isTrustedNavigation(new URL(notice.url, rootUrl).toString(), rootUrl)) return
    if (!Notification.isSupported()) return
    const success = notice.outcome === 'succeeded'
    const native = new Notification({
      title: success ? 'WorkStep 回复完成' : 'WorkStep 回复失败',
      body: `${notice.taskId ? '任务' : '会话'}的回复${success ? '已完成' : '失败'}`,
    })
    native.on('click', () => {
      if (window.isDestroyed()) return
      window.show()
      window.focus()
      void window.loadURL(new URL(notice.url, rootUrl).toString())
    })
    native.show()
  })
  window.once('ready-to-show', () => window.show())
  void window.loadURL(url)
  mainWindow = window
  registerSandboxIpc({ ipcMain, dialog, shell, manager: sandboxManager,
    window: () => mainWindow, rootUrl: () => rootUrl, hasActiveWork,
    restart: async () => { await stopBackend(); app.relaunch(); app.quit() },
  })
  return window
}

async function backendUrl() {
  const requestedPort = resolveBackendPort()
  const sandbox = await sandboxManager.settings()
  if (sandbox.enabled) {
    desktopToken = randomBytes(32).toString('hex')
    const env = app.isPackaged ? managedEnvironment(process.resourcesPath,
      require('../package.json').managedGatewayRootFingerprint) : {}
    if (env.WORKSTEP_MANAGED_BUNDLE_DIR) {
      const target = path.join(sandbox.root, 'desktop/managed-gateway')
      await fs.cp(env.WORKSTEP_MANAGED_BUNDLE_DIR, target, { recursive: true })
      env.WORKSTEP_MANAGED_BUNDLE_DIR = '/usr/local/share/workstep-managed'
    }
    env.WORKSTEP_VERSION = app.getVersion()
    return sandboxManager.start(requestedPort, desktopToken, env)
  }
  if (!app.isPackaged) {
    return process.env.WORKSTEP_DEV_SERVER_URL
      ?? `http://127.0.0.1:${requestedPort || 8766}`
  }
  const launch = backendLaunch(process.resourcesPath)
  const managedEnv = managedEnvironment(
    process.resourcesPath, require('../package.json').managedGatewayRootFingerprint,
  )
  desktopToken = randomBytes(32).toString('hex')
  const result = await startSidecar({
    ...launch,
    port: requestedPort,
    env: {
      ...process.env,
      // The signed application bundle must remain unchanged after launch.
      PYTHONDONTWRITEBYTECODE: '1',
      WORKSTEP_DESKTOP_RUNTIME: '1',
      WORKSTEP_DESKTOP_TOKEN: desktopToken,
      WORKSTEP_VERSION: app.getVersion(),
      ...managedEnv,
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
    if (localSession) details.requestHeaders['X-WorkStep-Local-Session'] = localSession
    callback({ requestHeaders: details.requestHeaders })
  })
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}

function beginManagedReauthentication(managed) {
  if (reauthenticating) return
  localSession = null
  reauthenticating = (async () => {
    for (;;) {
      try {
        const authorization = await authorizeManagedDesktop(managed)
        if (!authorization) { app.quit(); return }
        await bootstrapManagedBackend(rootUrl, authorization)
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
        return
      } catch (error) {
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'error', title: 'WorkStep 需要重新登录',
          message: '本机会话或网关控制授权已失效，重新登录后继续使用。',
          detail: error instanceof Error ? error.message : String(error),
          buttons: ['重试', '退出'], defaultId: 0, cancelId: 1,
        })
        if (result.response === 1) { app.quit(); return }
      }
    }
  })().finally(() => { reauthenticating = null })
}

function configureManagedSessionRecovery(managed) {
  const parsed = new URL(rootUrl)
  session.defaultSession.webRequest.onCompleted({ urls: [`${parsed.origin}/*`] }, (details) => {
    if (managedSessionExpired(details, rootUrl)) beginManagedReauthentication(managed)
  })
  controlStatusTimer = setInterval(() => {
    if (reauthenticating || !localSession) return
    void fetch(`${rootUrl}/api/managed/control-status`, {
      headers: { 'X-WorkStep-Desktop-Token': desktopToken,
        'X-WorkStep-Local-Session': localSession },
      signal: AbortSignal.timeout(5000),
    }).then(async (response) => {
      if (response.status === 401 || (response.ok && (await response.json()).authorization_required)) {
        beginManagedReauthentication(managed)
      }
    }).catch(() => {})
  }, 30000)
  controlStatusTimer.unref()
}

async function hasActiveWork() {
  if (!rootUrl || (!desktopToken && app.isPackaged)) return true
  try {
    const response = await fetch(`${rootUrl}/api/project/list`, {
      headers: { 'X-WorkStep-Desktop-Token': desktopToken,
        ...(localSession ? { 'X-WorkStep-Local-Session': localSession } : {}) },
    })
    if (!response.ok) return true
    const projectsPayload = await response.json()
    if (projectsHaveActiveWork(projectsPayload)) return true
    for (const project of projectsPayload.projects) {
      if (!project?.id || project?.type === 'remote') continue
      const sessionsResponse = await fetch(
        `${rootUrl}/api/chat-sessions?project_id=${encodeURIComponent(project.id)}`,
        { headers: { 'X-WorkStep-Desktop-Token': desktopToken,
          ...(localSession ? { 'X-WorkStep-Local-Session': localSession } : {}) } },
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
  const channel = updaterChannel(process.platform, process.arch)
  if (channel) autoUpdater.channel = channel
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', () => void promptForUpdateInstall())
  autoUpdater.on('error', (error) => console.error('Auto update failed', error))
  void autoUpdater.checkForUpdatesAndNotify().catch((error) => {
    console.error('Unable to check for desktop updates', error)
  })
}

app.on('before-quit', (event) => {
  if (controlStatusTimer) clearInterval(controlStatusTimer)
  if (installingUpdate || (!backendProcess && !sandboxManager?.session)) return
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
  const release = require('./sandbox-release.json')
  const image = app.isPackaged ? release.image : process.env.WORKSTEP_SANDBOX_IMAGE || release.image
  sandboxManager = new SandboxManager({ stateDir: app.getPath('userData'), image })
  let managed = null
  try {
    managed = app.isPackaged
      ? readManagedConfig(process.resourcesPath,
        require('../package.json').managedGatewayRootFingerprint)
      : null
    let managedAuthorization = null
    if (managed) {
      app.setAsDefaultProtocolClient('workstep')
      if (pendingProtocolUrl?.startsWith('workstep://auth/')) pendingProtocolUrl = null
      managedAuthorization = await authorizeManagedDesktop(managed)
      if (!managedAuthorization) {
        app.quit()
        return
      }
    }
    for (;;) {
      try { rootUrl = await backendUrl(); break } catch (error) {
        if (!(await sandboxManager.settings()).enabled) throw error
        const result = await dialog.showMessageBox({ type: 'error', title: 'WorkStep 沙箱启动失败',
          message: error instanceof Error ? error.message : String(error),
          buttons: ['重试', '打开日志目录', '切回非沙箱', '退出'], defaultId: 0, cancelId: 3 })
        if (result.response === 3) { app.quit(); return }
        if (result.response === 1) {
          await sandboxManager.logWrite
          await shell.openPath(path.join((await sandboxManager.settings()).root, 'desktop'))
        }
        if (result.response === 2) await sandboxManager.setEnabled(false)
      }
    }
    if (managedAuthorization) await bootstrapManagedBackend(rootUrl, managedAuthorization)
    configureAuthenticatedRequests(rootUrl)
    const initialPath = pendingProtocolUrl ? protocolPath(pendingProtocolUrl) : '/'
    createWindow(`${rootUrl}${initialPath}`)
    if (managed) configureManagedSessionRecovery(managed)
    configureUpdater()
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'WorkStep 无法启动',
      message: managed ? '网关登录或本地后台启动失败' : '本地后台服务启动失败',
      detail: error instanceof Error ? error.message : String(error),
    })
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
