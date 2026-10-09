const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const path = require('node:path')

function desktopHarness() {
  const windows = [], external = [], handlers = new Map()
  const sourcePath = path.join(__dirname, '../src/main.cjs')
  const realRequire = createRequire(sourcePath)
  class Window {
    constructor(options) {
      this.options = options
      this.events = new Map()
      this.webContents = {
        on: (event, callback) => handlers.set(event, callback),
        setWindowOpenHandler: callback => { this.openHandler = callback },
      }
      windows.push(this)
    }
    on(event, callback) { this.events.set(event, callback) }
    once(event, callback) { this.events.set(event, callback) }
    loadURL(url) { this.url = url; return Promise.resolve() }
    show() {}
    focus() {}
    close() { this.closed = true; this.events.get('closed')?.() }
    isDestroyed() { return !!this.closed }
  }
  const context = vm.createContext({
    console, Buffer, URL, process, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), __dirname: path.dirname(sourcePath),
    require(name) {
      if (name === 'electron') return {
        BrowserWindow: Window,
        session: { defaultSession: {
          webRequest: {
            onCompleted: (_filter, callback) => handlers.set('completed', callback),
            onBeforeSendHeaders: (filter, callback) => {
              handlers.set('request-filter', filter)
              handlers.set('request-headers', callback)
            },
          },
          setPermissionRequestHandler() {},
        } },
        app: { on() {}, getVersion: () => '1.0.9', requestSingleInstanceLock: () => true,
          whenReady: () => new Promise(() => {}), getPath: () => '/tmp/login-test' },
        shell: { openExternal: async url => external.push(url) },
        ipcMain: { removeAllListeners() {}, on() {} },
      }
      if (name === './sandbox-ipc.cjs') return { registerSandboxIpc() {} }
      if (name === './credential-store.cjs') return {
        loadOrCreateDeviceIdentity: async () => ({ appInstanceId: 'test-app' }),
      }
      if (name === './desktop-auth.cjs') return {
        parseAuthCallback: realRequire(name).parseAuthCallback,
        createAuthorizationRequest: () => ({ authorizationUrl: 'http://192.168.52.156:8700/desktop/login' }),
        claimAuthCallback: () => ({ code: 'test-code' }),
        exchangeDesktopCode: async () => { throw new Error('callback reached exchange') },
      }
      return realRequire(name)
    },
  })
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath })
  return { context, windows, external, handlers }
}

test('managed desktop login opens an embedded window and intercepts the auth callback', async () => {
  const { context, windows, external, handlers } = desktopHarness()
  const pending = vm.runInContext('authorizeManagedDesktop({ gateway_id: "test" })', context)
  const rejected = assert.rejects(pending, /callback reached exchange/)
  await new Promise(resolve => setImmediate(resolve))
  try {
    assert.deepEqual(external, [], 'login must not launch the system browser')
    assert.equal(windows.length, 1)
    assert.equal(windows[0].url, 'http://192.168.52.156:8700/desktop/login')
    let prevented = false
    handlers.get('will-redirect')({ preventDefault() { prevented = true } }, 'workstep://auth/callback?code=test-code&state=test')
    await rejected
    assert.equal(prevented, true)
    assert.equal(windows[0].closed, true)
  } finally {
    vm.runInContext('clearTimeout(managedCallbackTimeout)', context)
  }
})

for (const entry of ['popup', 'redirect']) {
  test(`configured gateway ${entry} login opens inside the desktop`, () => {
    const { context, windows, external, handlers } = desktopHarness()
    const main = vm.runInContext('rootUrl = "http://127.0.0.1:8766"; createWindow(rootUrl)', context)
    const query = new URLSearchParams({ gateway_id: 'gateway-test', app_instance_id: 'app-test',
      state: 's'.repeat(32), nonce: 'n'.repeat(32), code_challenge: 'A'.repeat(43) })
    const url = `http://192.168.52.156:8700/desktop/login?${query}`
    if (entry === 'popup') main.openHandler({ url })
    else {
      assert.equal(typeof handlers.get('will-redirect'), 'function')
      handlers.get('will-redirect')({ preventDefault() {} }, url)
    }
    assert.deepEqual(external, [], 'login must not launch the system browser')
    assert.equal(windows.length, 2)
    assert.equal(windows[1].url, url)
  })
}


test('configured gateway session expiry returns the desktop to embedded login', async () => {
  const { context, windows, external, handlers } = desktopHarness()
  const main = vm.runInContext('rootUrl = "http://127.0.0.1:8766"; createWindow(rootUrl + "/tasks?project=t1")', context)
  vm.runInContext('beginManagedReauthentication = () => {}; configureManagedSessionRecovery(null)', context)
  handlers.get('completed')({ url: 'http://127.0.0.1:8766/api/projects', statusCode: 401,
    responseHeaders: { 'X-WorkStep-Managed-Session-Expired': ['1'] } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(main.url, 'http://127.0.0.1:8766/')
  assert.equal(windows.length, 1)
  assert.deepEqual(external, [])
})

test('desktop injects its runtime credential into daemon HTTP and WebSocket requests', () => {
  const { context, handlers } = desktopHarness()
  vm.runInContext('desktopToken = "per-launch-secret"; configureAuthenticatedRequests("http://127.0.0.1:8766")', context)
  assert.deepEqual(Array.from(handlers.get('request-filter').urls), [
    'http://127.0.0.1:8766/*', 'ws://127.0.0.1:8766/*',
  ])
  for (const url of ['http://127.0.0.1:8766/api/projects', 'ws://127.0.0.1:8766/ws']) {
    let result
    handlers.get('request-headers')({ url, requestHeaders: { 'X-WorkStep-Desktop-Token': 'page-supplied-value' } }, value => { result = value })
    assert.equal(result.requestHeaders['X-WorkStep-Desktop-Token'], 'per-launch-secret')
  }
})

test('configured gateway callback displays the device authorization rejection', async () => {
  const { context } = desktopHarness()
  const detail = '此设备已被网关停用或撤销，请联系网关管理员处理设备授权。'
  context.fetch = async () => ({ status: 403, json: async () => ({ detail }) })
  context.AbortSignal = AbortSignal
  vm.runInContext('rootUrl = "http://127.0.0.1:8766"; desktopToken = "per-launch-secret"', context)
  await assert.rejects(vm.runInContext('completeConfiguredGatewayCallback("workstep://auth/callback?code=" + "c".repeat(32) + "&state=" + "s".repeat(32))', context),
    error => error.message === detail)
})
