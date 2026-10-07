const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('workstepDesktop', {
  sandbox: process.platform === 'win32' && process.arch === 'ia32' ? undefined : {
    status: () => ipcRenderer.invoke('workstep:sandbox:status'),
    dockerImages: () => ipcRenderer.invoke('workstep:sandbox:dockerImages'),
    chooseDirectory: () => ipcRenderer.invoke('workstep:sandbox:chooseDirectory'),
    prepare: (settings) => ipcRenderer.invoke('workstep:sandbox:prepare', settings),
    switchMode: (enabled) => ipcRenderer.invoke('workstep:sandbox:switchMode', enabled),
    importConfig: (kind) => ipcRenderer.invoke('workstep:sandbox:importConfig', kind),
    remove: () => ipcRenderer.invoke('workstep:sandbox:remove'),
    logs: () => ipcRenderer.invoke('workstep:sandbox:logs'),
  },
  notify: (notice) => ipcRenderer.send('workstep:notify', notice),
})
