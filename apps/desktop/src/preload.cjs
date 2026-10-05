const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('workstepDesktop', {
  notify: (notice) => ipcRenderer.send('workstep:notify', notice),
})
