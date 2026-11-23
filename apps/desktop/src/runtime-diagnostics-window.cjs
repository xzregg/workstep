const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')

const channel = 'workstep:runtime-diagnostics'
const assets = ['runtime-diagnostics.js', 'runtime-diagnostics-view.js', 'runtime-diagnostics-native.js']
const read = file => fs.readFile(path.join(__dirname, file), 'utf8')
const hash = content => `'sha256-${createHash('sha256').update(content).digest('base64')}'`

async function localPage() {
  const [html, css, ...scripts] = await Promise.all([
    read('runtime-diagnostics.html'), read('runtime-diagnostics.css'), ...assets.map(read),
  ])
  let text = html.replace("script-src 'self'", () => 'script-src ' + scripts.map(hash).join(' '))
    .replace("style-src 'self'", () => 'style-src ' + hash(css))
    .replace('<link rel="stylesheet" href="runtime-diagnostics.css">', () => `<style>${css}</style>`)
  for (const [index, asset] of assets.entries()) {
    text = text.replace(`<script src="${asset}"></script>`, () => `<script>${scripts[index]}</script>`)
  }
  return `data:text/html;charset=UTF-8,${encodeURIComponent(text)}`
}

function createRuntimeDiagnosticsWindow({ BrowserWindow, ipcMain, clipboard, dialog, logger, getMainWindow,
  isTrusted, getSandboxLog, version }) {
  let window
  let page
  let result = null
  let watched
  let workbenchEpoch = 0

  function currentWorkbench() {
    const current = getMainWindow()
    if (!current || current.isDestroyed() || current.webContents.isDestroyed() || current.webContents.isCrashed() ||
      !isTrusted(current.webContents.getURL())) return null
    const contents = current.webContents
    if (watched !== contents) {
      watched = contents
      workbenchEpoch++
      const nextDocument = details => {
        if (!details.isMainFrame) return
        if (!details.isSameDocument) workbenchEpoch++
        if (!isTrusted(details.url) && contents.isDevToolsOpened()) contents.closeDevTools()
      }
      contents.on('did-start-navigation', nextDocument)
      contents.on('render-process-gone', () => { workbenchEpoch++ })
    }
    return current
  }

  async function evaluate(script, current = currentWorkbench()) {
    if (!current) return null
    const epoch = workbenchEpoch
    const value = await current.webContents.executeJavaScript(script)
    return current === currentWorkbench() && epoch === workbenchEpoch ? value : null
  }

  async function status() {
    const current = currentWorkbench()
    const sample = current ? await evaluate('window.workstepPerformance?.snapshot() ?? null', current).catch(() => null) : null
    if (sample?.result) result = sample.result
    return { available: Boolean(current), performance: { recording: Boolean(sample?.recording), result },
      environment: { platform: 'desktop', version, runtime: `Electron ${process.versions.electron}`, os: process.platform } }
  }

  async function invoke(event, action, payload) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame?.url !== page) throw new Error('Untrusted diagnostics request')
    if (action === 'status') return status()
    if (action === 'read') {
      const [state, sandbox, browser] = await Promise.all([
        status(), Promise.resolve().then(getSandboxLog).catch(() => undefined),
        evaluate('window.workstepRuntimeLogSnapshot?.() ?? []').catch(() => []),
      ])
      const report = await logger.collectReport(sandbox, 128 * 1024, false)
      const streams = Object.entries(report.logs).map(([name, text]) => ({
        source: name.startsWith('sandbox') ? 'sandbox' : name.split('.')[0], text,
      }))
      for (const source of ['page', 'request']) {
        const records = (Array.isArray(browser) ? browser : []).slice(0, 100)
          .filter(entry => entry?.kind === source && typeof entry.detail === 'string' &&
            /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(entry.at))
          .map(entry => `${entry.at} ${['error', 'warn', 'info'].includes(entry.level) ? entry.level : 'info'} ${logger.redact(entry.detail).slice(0, 2048)}`)
        if (records.length) streams.push({ source, text: records.join('\n') })
      }
      return { ...state, streams, warning: report.warnings[0] }
    }
    if (action === 'start') {
      const current = currentWorkbench()
      if (!current) return false
      const sampler = await read(assets[0])
      if (current !== currentWorkbench()) return false
      current.show()
      if (current.isMinimized()) current.restore()
      current.focus()
      const started = await evaluate(`${sampler}\n;window.workstepPerformance.start()`, current)
      if (started) { result = null; window?.hide() }
      return started
    }
    if (action === 'stop') {
      result = await evaluate('window.workstepPerformance?.stop() ?? null') || result
      return true
    }
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > 2 * 1024 * 1024) {
      throw new Error('Invalid diagnostics payload')
    }
    if (action === 'copy') { clipboard.writeText(payload); return true }
    if (action === 'save') {
      const choice = await dialog.showSaveDialog(window, {
        title: '导出运行诊断', defaultPath: 'WorkStep-runtime-diagnostics.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (choice.canceled || !choice.filePath) return false
      await fs.writeFile(choice.filePath, payload, { mode: 0o600 })
      return true
    }
    throw new Error('Unknown diagnostics action')
  }

  ipcMain.handle(channel, invoke)
  return {
    async open({ quitOnClose = false, quit } = {}) {
      if (window && !window.isDestroyed()) { window.restore(); window.show(); window.focus(); return }
      page = await localPage()
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return }
      const view = new BrowserWindow({
        title: '运行诊断', width: 780, height: 640, minWidth: 420, minHeight: 360,
        show: false, resizable: true, autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false,
          preload: path.join(__dirname, 'runtime-diagnostics-preload.cjs'),
        },
      })
      window = view
      view.setMenu(null)
      view.webContents.on('will-navigate', event => event.preventDefault())
      view.webContents.on('will-redirect', event => event.preventDefault())
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.once('ready-to-show', () => view.show())
      view.once('closed', () => { if (view === window) window = null; if (quitOnClose) quit?.() })
      try { await view.loadURL(page) }
      catch (error) { view.destroy(); throw error }
    },
    openDevTools() {
      const current = currentWorkbench()
      if (!current) return
      const { webContents } = current
      webContents.openDevTools({ mode: 'detach' })
    },
  }
}

module.exports = { createRuntimeDiagnosticsWindow, localPage }
