const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('feedback', {
  copyText: () => ipcRenderer.invoke('workstep:feedback:action', 'copyText'),
  capture: () => ipcRenderer.invoke('workstep:feedback:action', 'capture'),
  copyImage: () => ipcRenderer.invoke('workstep:feedback:action', 'copyImage'),
  clearImage: () => ipcRenderer.invoke('workstep:feedback:action', 'clearImage'),
})
