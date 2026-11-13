const path = require('node:path')
/** A local-only avatar surface. Never loads remote content or receives credentials. */
function createDigitalPersonWindow({ BrowserWindow, ipcMain, getMain, trusted }) {
  let window = null, state = {}, dismissed = false
  const channels = ['workstep:digital-person:sync', 'workstep:digital-person:open', 'workstep:digital-person:hide']
  function close() { if (window && !window.isDestroyed()) window.close(); window = null }
  ipcMain.handle(channels[0], (event, value) => {
    if (!trusted(event)) throw new Error('Untrusted digital person sender')
    state = { name: String(value?.name || '').slice(0, 80), role: String(value?.role || '').slice(0, 200),
      expression: ['happy','concern'].includes(value?.expression) ? value.expression : 'neutral', speaking: value?.speaking === true }
    if (value?.enabled !== true) { dismissed = false; close(); return }
    if (dismissed) return
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({ width: 240, height: 280, minWidth: 180, minHeight: 220,
        maxWidth: 500, maxHeight: 600, frame: false, transparent: true, alwaysOnTop: true,
        skipTaskbar: true, resizable: true, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
          preload: path.join(__dirname, 'digital-person-preload.cjs') } })
      const current = window
      current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      current.webContents.on('will-navigate', event => event.preventDefault())
      current.webContents.on('did-finish-load', () => { current.webContents.send('workstep:digital-person:state', state); current.show() })
      current.on('closed', () => { if (window === current) window = null })
      void current.loadFile(path.join(__dirname, 'digital-person.html'))
    } else window.webContents.send('workstep:digital-person:state', state)
  })
  const checkAvatar = event => { if (!window || event.sender !== window.webContents) throw new Error('Untrusted avatar sender') }
  ipcMain.handle(channels[1], event => {
    checkAvatar(event)
    const main = getMain()
    if (main?.isMinimized()) main.restore()
    main?.show(); main?.focus(); main?.webContents.send('workstep:digital-person:open-chat')
  })
  ipcMain.handle(channels[2], event => { checkAvatar(event); dismissed = true; close() })
  return { dispose() { close(); channels.forEach(channel => ipcMain.removeHandler(channel)) } }
}
module.exports = { createDigitalPersonWindow }
