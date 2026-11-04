const { app, BrowserWindow, ipcMain, clipboard, session } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createDiagnostics } = require('../../src/diagnostics.cjs')
const { createFeedbackService, registerFeedbackIpc, captureRendererErrors } = require('../../src/feedback.cjs')
const { createFeedbackWindowController } = require('../../src/feedback-window.cjs')

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw Error('Timed out waiting for feedback UI')
}

let directory, server, savedClipboard
async function run() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-feedback-acceptance-'))
  app.setPath('userData', directory)
  await app.whenReady()
  // Reproduce the packaged app's unavailable file transport, including assets.
  session.defaultSession.protocol.handle('file', () => new Response('', { status: 404 }))
  savedClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() }
  server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><body><h1>操作手册演示</h1><p>反馈测试页面，不含私人内容</p></body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = `http://127.0.0.1:${server.address().port}`
  const workspace = new BrowserWindow({ width: 900, height: 700, webPreferences: {
    preload: path.resolve(__dirname, '../../src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
  const diagnostics = createDiagnostics({ directory: path.join(directory, 'logs'), metadata: { version: 'test', platform: process.platform, arch: process.arch } })
  captureRendererErrors(workspace.webContents, diagnostics, () => root)
  let captures = 0
  const capture = workspace.webContents.capturePage.bind(workspace.webContents)
  workspace.webContents.capturePage = async (...args) => { captures++; return capture(...args) }
  const service = createFeedbackService({ diagnostics, clipboard, getWindow: () => workspace, rootUrl: () => root,
    runtime: async () => ({ uptimeSeconds: 42, backendMode: '测试', backendState: '不可用' }) })
  const controller = createFeedbackWindowController({ BrowserWindow, service })
  registerFeedbackIpc({ ipcMain, service, getWindow: () => workspace, getFeedbackWindow: controller.getWindow, rootUrl: () => root, open: () => controller.open() })
  await workspace.loadURL(root)
  await workspace.webContents.executeJavaScript(`setTimeout(() => { throw new Error('feedback sync canary') }, 0); Promise.reject(new Error('feedback async canary')); void 0`)
  await waitFor(async () => {
    const report = await diagnostics.collectReport()
    return report.logs['desktop.log']?.includes('feedback async canary') && report.logs['desktop.log']?.includes('feedback sync canary')
  })
  await workspace.webContents.executeJavaScript('window.workstepDesktop.feedback.open()')
  const preview = controller.getWindow()
  assert.match(preview.webContents.getURL(), /^data:text\/html/)
  await waitFor(() => preview.webContents.executeJavaScript("document.getElementById('status').textContent.includes('反馈信息已复制')"))
  assert.equal(await preview.webContents.executeJavaScript("getComputedStyle(document.body).display"), 'flex', 'bundled styles load under CSP')
  assert.equal(captures, 0, 'opening feedback must never take a screenshot')
  const text = clipboard.readText()
  assert.match(text, /42秒/)
  assert.match(text, /feedback async canary/)
  assert.match(text, /feedback sync canary/)
  await preview.webContents.executeJavaScript("document.getElementById('capture').click()")
  await waitFor(() => preview.webContents.executeJavaScript("Boolean(document.querySelector('#image-preview img')?.naturalWidth)"))
  assert.equal(captures, 1)
  assert.equal(clipboard.readText(), text, 'preview preserves the text clipboard')
  assert.equal(await preview.webContents.executeJavaScript("document.getElementById('copy-image').getBoundingClientRect().bottom <= document.querySelector('footer').getBoundingClientRect().top"), true, 'preview actions remain visible')
  await preview.webContents.executeJavaScript("document.getElementById('cancel-image').click()")
  await waitFor(() => preview.webContents.executeJavaScript("!document.querySelector('#image-preview img') && !document.getElementById('status').hasAttribute('data-busy')"))
  assert.equal(clipboard.readText(), text)
  await preview.webContents.executeJavaScript("document.getElementById('capture').click()")
  await waitFor(() => preview.webContents.executeJavaScript("Boolean(document.querySelector('#image-preview img')?.naturalWidth)"))
  await preview.webContents.executeJavaScript("document.getElementById('copy-image').click()")
  await waitFor(() => preview.webContents.executeJavaScript("document.getElementById('status').textContent.includes('截图已复制')"))
  assert.equal(clipboard.readImage().isEmpty(), false)
  assert.equal(clipboard.readImage().getSize().width, (await capture()).getSize().width)
  const image = await preview.webContents.capturePage()
  await fs.writeFile('/tmp/workstep-feedback-preview.png', image.toPNG())
  await new Promise(resolve => { preview.once('closed', resolve); preview.close() })
  await assert.rejects(service.copyImage(), /截图/)
  workspace.destroy()
  await diagnostics.flush()
  console.log('FEEDBACK_ACCEPTANCE_OK')
}

run().then(() => finish(0), error => { console.error(error); return finish(1) })
async function finish(code) {
  if (savedClipboard) clipboard.write(savedClipboard)
  server?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
  app.exit(code)
}
