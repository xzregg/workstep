const { createPrivateKey, randomBytes, sign } = require('node:crypto')
const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, safeStorage, session, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { SandboxManager } = require('./sandbox.cjs')
const { registerSandboxIpc } = require('./sandbox-ipc.cjs')
const { managedEnvironment, readManagedConfig } = require('./managed-config.cjs')
const { loadOrCreateDeviceIdentity } = require('./credential-store.cjs')
const { managedSessionExpired } = require('./managed-session.cjs')
const { desktopWindowTitle } = require('./window-title.cjs')
const { attachHideOnClose, createGracefulQuit } = require('./window-lifecycle.cjs')
const { createDesktopUpdateService, safeReleaseUrl } = require('./desktop-update.cjs')
const { createSandboxStartupWindow, formatSandboxFailure, applyPendingImageSwitch } = require('./sandbox-startup-window.cjs')
const {
  createAuthorizationRequest, parseAuthCallback, claimAuthCallback, exchangeDesktopCode,
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
  isGatewayDesktopLoginUrl,
  isTrustedNavigation,
  projectsHaveActiveWork,
  sessionsHaveActiveWork,
  primaryNetworkIPv4,
} = require('./security.cjs')

let sandboxManager = null
let backendProcess = null
let stopping = null
let mainWindow = null
let sandboxStartup = null
let rootUrl = null
let desktopToken = null
let localSession = null
let managedPending = null
let managedCallbackResolve = null
let managedCallbackTimeout = null
let reauthenticating = null
let controlStatusTimer = null
let updateCheckTimer = null
let tray = null
let quitting = false
let windowsVisible = true
let gatewayLoginWindow = null
let gatewayLoginReturnUrl = null
let sandboxSwitchSignal = 0
let pendingProtocolUrl = process.argv.find((value) => value.startsWith('workstep://')) ?? null

async function completeConfiguredGatewayCallback(value) {
  if (!rootUrl || !desktopToken) throw new Error('WorkStep desktop backend is not ready')
  const callback = parseAuthCallback(value)
  const target = new URL('/api/gateway-platform/callback', rootUrl)
  target.searchParams.set('code', callback.code)
  target.searchParams.set('state', callback.state)
  const response = await fetch(target, {
    redirect: 'manual',
    headers: { 'X-WorkStep-Desktop-Token': desktopToken },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status !== 303) {
    const body = await response.json().catch(() => null)
    const detail = typeof body?.detail === 'string' ? body.detail : `网关登录失败（${response.status}）`
    throw new Error(detail)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    const returnUrl = gatewayLoginReturnUrl || rootUrl
    gatewayLoginReturnUrl = null
    await mainWindow.loadURL(returnUrl)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function openProtocolUrl(value) {
  if (value === 'workstep://auth/cancel') {
    returnToLocalWorkspace()
    return
  }
  if (value.startsWith('workstep://auth/')) {
    if (managedPending && managedCallbackResolve) {
      try {
        const callback = claimAuthCallback(value, managedPending)
        clearTimeout(managedCallbackTimeout)
        managedCallbackResolve(callback)
        managedCallbackResolve = null
      } catch (error) {
        console.error('Ignoring invalid WorkStep auth callback', error)
      }
    } else if (rootUrl && desktopToken) {
      void completeConfiguredGatewayCallback(value).catch((error) => {
        returnToLocalWorkspace()
        console.error('Unable to complete configured Gateway login', error)
        const options = { type: 'error', title: '网关登录失败',
          message: '无法完成网关登录。', detail: error.message || String(error) }
        void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
      })
    } else {
      pendingProtocolUrl = value
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

function returnToLocalWorkspace() {
  if (!rootUrl || !mainWindow || mainWindow.isDestroyed()) return
  const target = new URL(gatewayLoginReturnUrl || rootUrl)
  target.searchParams.set('gateway_auth', 'cancelled')
  gatewayLoginReturnUrl = null
  void mainWindow.loadURL(target.href).catch(error => console.error('Unable to return to local workspace', error))
  mainWindow.show()
  mainWindow.focus()
}

function openGatewayLoginWindow(targetUrl) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!gatewayLoginReturnUrl) {
      const currentUrl = mainWindow.webContents.getURL()
      gatewayLoginReturnUrl = isTrustedNavigation(currentUrl, rootUrl) ? currentUrl : rootUrl
    }
    void mainWindow.loadURL(targetUrl).catch(() => { if (gatewayLoginReturnUrl) returnToLocalWorkspace() })
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (gatewayLoginWindow && !gatewayLoginWindow.isDestroyed()) {
    void gatewayLoginWindow.loadURL(targetUrl)
    gatewayLoginWindow.show()
    gatewayLoginWindow.focus()
    return
  }
  const window = new BrowserWindow({
    parent: mainWindow ?? undefined,
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 600,
    show: false,
    title: '登录 WorkStep 平台',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  gatewayLoginWindow = window
  const handleNavigation = (event, destination) => {
    if (destination.startsWith('workstep://auth/')) {
      event.preventDefault()
      openProtocolUrl(destination)
      window.close()
      return
    }
    if (!isAllowedExternalUrl(destination)) event.preventDefault()
  }
  window.webContents.on('will-navigate', handleNavigation)
  window.webContents.on('will-redirect', handleNavigation)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void window.loadURL(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { if (gatewayLoginWindow === window) gatewayLoginWindow = null })
  void window.loadURL(targetUrl)
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
    openGatewayLoginWindow(pending.authorizationUrl)
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
  const title = desktopWindowTitle(app.isPackaged, app.getVersion())
  const window = new BrowserWindow({
    title,
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
  attachHideOnClose(window, () => quitting, () => { windowsVisible = false })
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(title)
  })
  const handleNavigation = (event, targetUrl) => {
    if (gatewayLoginReturnUrl && targetUrl.startsWith('workstep://auth/')) {
      event.preventDefault()
      openProtocolUrl(targetUrl)
      return
    }
    if (isTrustedNavigation(targetUrl, rootUrl)) return
    if (gatewayLoginReturnUrl && isAllowedExternalUrl(targetUrl)) return
    event.preventDefault()
    if (isGatewayDesktopLoginUrl(targetUrl)) {
      openGatewayLoginWindow(targetUrl)
      return
    }
    if (isAllowedExternalUrl(targetUrl)) void shell.openExternal(targetUrl)
  }
  window.webContents.on('will-navigate', handleNavigation)
  window.webContents.on('will-redirect', handleNavigation)
  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (gatewayLoginReturnUrl && targetUrl.startsWith('workstep://auth/')) openProtocolUrl(targetUrl)
    else if (gatewayLoginReturnUrl && isAllowedExternalUrl(targetUrl)) void window.loadURL(targetUrl)
    else if (isGatewayDesktopLoginUrl(targetUrl)) openGatewayLoginWindow(targetUrl)
    else if (isAllowedExternalUrl(targetUrl)) void shell.openExternal(targetUrl)
    return { action: 'deny' }
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (gatewayLoginReturnUrl && input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      returnToLocalWorkspace()
    }
  })
  window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (gatewayLoginReturnUrl && isMainFrame && code !== -3) returnToLocalWorkspace()
  })
  window.webContents.on('context-menu', () => {
    if (gatewayLoginReturnUrl || !isTrustedNavigation(window.webContents.getURL(), rootUrl)) Menu.buildFromTemplate([
      { label: '返回本地工作台', click: returnToLocalWorkspace },
    ]).popup({ window })
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
  window.once('ready-to-show', () => { if (windowsVisible) window.show() })
  void window.loadURL(url)
  mainWindow = window
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'WorkStep', submenu: [
      { label: '返回本地工作台', accelerator: 'CmdOrCtrl+Shift+H', click: returnToLocalWorkspace },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]))
  registerSandboxIpc({ ipcMain, dialog, shell, clipboard, manager: sandboxManager,
    window: () => mainWindow, rootUrl: () => rootUrl, hasActiveWork,
    restart: async () => { await stopBackend(); app.relaunch(); app.quit() },
  })
  return window
}

function showDesktopWindow() {
  windowsVisible = true
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : sandboxStartup?.window
  if (!window || window.isDestroyed()) return
  window.show()
  if (window.isMinimized()) window.restore()
  window.focus()
}

async function hasActiveWork() {
  if (!rootUrl || (!desktopToken && app.isPackaged)) return true
  try {
    const headers = { 'X-WorkStep-Desktop-Token': desktopToken,
      ...(localSession ? { 'X-WorkStep-Local-Session': localSession } : {}) }
    const response = await fetch(`${rootUrl}/api/project/list`, { headers })
    if (!response.ok) return true
    const projectsPayload = await response.json()
    if (projectsHaveActiveWork(projectsPayload)) return true
    for (const project of projectsPayload.projects) {
      if (!project?.id || project?.type === 'remote') continue
      const sessionsResponse = await fetch(
        `${rootUrl}/api/chat-sessions?project_id=${encodeURIComponent(project.id)}`, { headers },
      )
      if (!sessionsResponse.ok || sessionsHaveActiveWork(await sessionsResponse.json())) return true
    }
    return false
  } catch (error) {
    console.error('Unable to verify active work', error)
    return true
  }
}

function configureTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray-icon.png')
    : path.join(__dirname, '../build/icons/32x32.png')
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
  tray = new Tray(icon)
  tray.setToolTip('WorkStep')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 WorkStep', click: showDesktopWindow },
    { label: '返回本地工作台', click: returnToLocalWorkspace },
    { type: 'separator' },
    { label: '退出 WorkStep', click: () => app.quit() },
  ]))
  tray.on('click', showDesktopWindow)
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

async function announceDesktopRuntime(url) {
  if (!desktopToken) return
  try {
    const parsed = new URL(url)
    const response = await fetch(`${parsed.origin}/api/remote-project/desktop-runtime`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WorkStep-Desktop-Token': desktopToken,
      },
      body: JSON.stringify({ host: primaryNetworkIPv4(), port: Number(parsed.port) }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) console.warn(`Unable to announce desktop runtime (${response.status})`)
  } catch (error) {
    // Older sandbox images do not expose this endpoint; keep them launchable.
    console.warn('Unable to announce desktop runtime', error)
  }
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
    if (!managedSessionExpired(details, rootUrl)) return
    if (managed) {
      beginManagedReauthentication(managed)
    } else if (!reauthenticating && mainWindow && !mainWindow.isDestroyed()) {
      // Configured gateways own their local session in the daemon. Reload the
      // entry route so its expired session redirects to the embedded login.
      reauthenticating = mainWindow.loadURL(`${rootUrl}/`)
        .catch(error => console.error('Unable to reopen gateway login', error))
        .finally(() => { reauthenticating = null })
    }
  })
  if (!managed) return
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

function configureUpdater() {
  const updater = createDesktopUpdateService(app)
  ipcMain.removeHandler('workstep:update:status')
  ipcMain.removeHandler('workstep:update:check')
  ipcMain.removeHandler('workstep:update:open-download')
  ipcMain.handle('workstep:update:status', () => updater.check())
  ipcMain.handle('workstep:update:check', () => updater.check({ force: true }))
  ipcMain.handle('workstep:update:open-download', (_event, url) => shell.openExternal(safeReleaseUrl(url)))
  if (app.isPackaged) {
    const check = () => void updater.check().catch(error => console.error('Unable to check for desktop updates', error))
    check()
    updateCheckTimer = setInterval(check, 24 * 60 * 60 * 1000)
    updateCheckTimer.unref()
  }
}

const handleGracefulQuit = createGracefulQuit({
  stop: stopBackend,
  quit: () => app.quit(),
  onStart: () => { quitting = true },
  onError: error => console.error('Unable to stop backend cleanly during quit', error),
})

app.on('before-quit', (event) => {
  if (controlStatusTimer) clearInterval(controlStatusTimer)
  if (updateCheckTimer) clearInterval(updateCheckTimer)
  handleGracefulQuit(event)
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
  app.setAsDefaultProtocolClient('workstep')
  configureTray()
  const release = require('./sandbox-release.json')
  const image = app.isPackaged ? release.image : process.env.WORKSTEP_SANDBOX_IMAGE || release.image
  sandboxManager = new SandboxManager({ stateDir: app.getPath('userData'), image, hostConfigFile: process.env.WORKSTEP_CONFIG_DIR ? path.join(process.env.WORKSTEP_CONFIG_DIR, 'config.json') : undefined,
    report: status => sandboxStartup?.update(status) })
  const startupAction = async (event, action, input) => {
    if (!sandboxStartup || event.sender !== sandboxStartup.window.webContents) throw new Error('沙箱启动操作来源无效')
    if (action === 'readLogs') return sandboxManager.readLogs()
    if (action === 'copyLogs') { clipboard.writeText(await sandboxManager.readLogs()); return }
    if (action === 'openLogs') {
      const settings = await sandboxManager.settings()
      if (settings.root) await shell.openPath(path.join(settings.root, 'desktop'))
      return
    }
    if (action === 'dockerImages') return sandboxManager.dockerImages()
    if (action === 'switchImage') {
      const available = await sandboxManager.dockerImages()
      if (available.error) throw new Error(available.error)
      const selected = available.images.find(item => item.id === input)
      if (!selected) throw new Error('请选择扫描结果中的兼容镜像')
      const tag = selected.tags[0] || null
      sandboxStartup.update({ phase: 'switching', message: `正在切换到 ${tag || input.slice(0, 19) + '…'}`, error: null })
      await sandboxManager.queueImageSwitch(input, tag)
      sandboxSwitchSignal += 1
      return { queued: true, image: input, tag }
    }
  }
  for (const action of ['readLogs', 'copyLogs', 'openLogs', 'dockerImages', 'switchImage']) {
    const channel = `workstep:sandbox:startup:${action}`
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input) => startupAction(event, action, input))
  }
  let managed = null
  try {
    managed = app.isPackaged
      ? readManagedConfig(process.resourcesPath,
        require('../package.json').managedGatewayRootFingerprint)
      : null
    let managedAuthorization = null
    if (managed) {
      if (pendingProtocolUrl?.startsWith('workstep://auth/')) pendingProtocolUrl = null
      managedAuthorization = await authorizeManagedDesktop(managed)
      if (!managedAuthorization) {
        app.quit()
        return
      }
    }
    const sandboxSettings = await sandboxManager.settings()
    if (sandboxSettings.enabled || sandboxSettings.pendingDockerImage) {
      sandboxStartup = createSandboxStartupWindow(BrowserWindow, {
        onUserClose: (event, window) => { event.preventDefault(); windowsVisible = false; window.hide() },
      })
    }
    const finishPendingImageSwitch = async () => {
      let observedSwitchSignal = sandboxSwitchSignal
      while ((await sandboxManager.settings()).pendingDockerImage) {
        try { await applyPendingImageSwitch(sandboxManager); return true }
        catch (error) {
          const status = await sandboxManager.status()
          sandboxStartup?.update({ ...status, phase: 'error', error: error instanceof Error ? error.message : String(error) })
          while (observedSwitchSignal === sandboxSwitchSignal) await new Promise(resolve => setTimeout(resolve, 250))
          observedSwitchSignal = sandboxSwitchSignal
        }
      }
      return false
    }
    await finishPendingImageSwitch()
    for (;;) {
      try { rootUrl = await backendUrl(); break } catch (error) {
        if ((await sandboxManager.settings()).pendingDockerImage) {
          await finishPendingImageSwitch()
          continue
        }
        if (!(await sandboxManager.settings()).enabled) throw error
        const status = await sandboxManager.status()
        sandboxStartup?.update({ ...status, phase: 'error', error: error instanceof Error ? error.message : String(error) })
        const result = await dialog.showMessageBox({ type: 'error', title: 'WorkStep 沙箱启动失败',
          message: '沙箱后台未能通过健康检查', detail: formatSandboxFailure(error, status),
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
    await announceDesktopRuntime(rootUrl)
    configureAuthenticatedRequests(rootUrl)
    if (!managed && pendingProtocolUrl?.startsWith('workstep://auth/')) {
      const callback = pendingProtocolUrl
      pendingProtocolUrl = null
      await completeConfiguredGatewayCallback(callback)
    }
    const initialPath = pendingProtocolUrl ? protocolPath(pendingProtocolUrl) : '/'
    createWindow(`${rootUrl}${initialPath}`)
    sandboxStartup?.close(); sandboxStartup = null
    configureManagedSessionRecovery(managed)
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

app.on('activate', showDesktopWindow)
