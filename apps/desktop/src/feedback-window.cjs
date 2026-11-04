const path = require('node:path')

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
      try { await current.loadFile(path.join(__dirname, 'feedback.html')) }
      catch (error) { current.destroy(); throw error }
    },
  }
}

module.exports = { createFeedbackWindowController }
