const path = require('node:path')
const fs = require('node:fs/promises')
const { createHash } = require('node:crypto')

async function feedbackPageUrl() {
  const [template, css, script] = await Promise.all(
    ['feedback.html', 'feedback.css', 'feedback-renderer.js'].map(file => fs.readFile(path.join(__dirname, file), 'utf8')),
  )
  const hash = content => `'sha256-${createHash('sha256').update(content).digest('base64')}'`
  // Packaged builds disable file protocol privileges. Bundle only these static
  // assets and authorize their exact contents without allowing arbitrary scripts.
  const markup = template
    .replace("script-src 'self'", () => `script-src ${hash(script)}`)
    .replace("style-src 'self'", () => `style-src ${hash(css)}`)
    .replace('<link rel="stylesheet" href="feedback.css">', () => `<style>${css}</style>`)
    .replace('<script src="feedback-renderer.js"></script>', () => `<script>${script}</script>`)
  return `data:text/html;charset=UTF-8,${encodeURIComponent(markup)}`
}

function createFeedbackWindowController({ BrowserWindow, service }) {
  let window = null
  return {
    getWindow: () => window,
    async open() {
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore()
        window.show(); window.focus()
        return
      }
      window = new BrowserWindow({
        title: '一键反馈', width: 720, height: 600, minWidth: 420, minHeight: 400,
        show: false, resizable: true, autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
          preload: path.join(__dirname, 'feedback-preload.cjs') },
      })
      const current = window
      current.setMenu(null)
      current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      current.webContents.on('will-navigate', event => event.preventDefault())
      current.webContents.on('will-attach-webview', event => event.preventDefault())
      current.once('ready-to-show', () => current.show())
      current.on('close', () => service.clear())
      current.on('closed', () => { service.clear(); if (window === current) window = null })
      try { await current.loadURL(await feedbackPageUrl()) }
      catch (error) { current.destroy(); throw error }
    },
  }
}

module.exports = { createFeedbackWindowController }
