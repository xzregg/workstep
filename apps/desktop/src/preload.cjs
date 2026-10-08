const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('workstepDesktop', {
  sandbox: process.platform === 'win32' && process.arch === 'ia32' ? undefined : {
    status: () => ipcRenderer.invoke('workstep:sandbox:status'),
    dockerImages: () => ipcRenderer.invoke('workstep:sandbox:dockerImages'),
    hostProjects: () => ipcRenderer.invoke('workstep:sandbox:hostProjects'),
    prepareRuntime: (input) => ipcRenderer.invoke('workstep:sandbox:prepareRuntime', input),
    prepareImage: (input) => ipcRenderer.invoke('workstep:sandbox:prepareImage', input),
    chooseDirectory: () => ipcRenderer.invoke('workstep:sandbox:chooseDirectory'),
    prepare: (settings) => ipcRenderer.invoke('workstep:sandbox:prepare', settings),
    switchMode: (enabled) => ipcRenderer.invoke('workstep:sandbox:switchMode', enabled),
    switchImage: (image) => ipcRenderer.invoke('workstep:sandbox:switchImage', image),
    importConfig: (kind) => ipcRenderer.invoke('workstep:sandbox:importConfig', kind),
    migrateSettings: (options) => ipcRenderer.invoke('workstep:sandbox:migrateSettings', options),
    remove: () => ipcRenderer.invoke('workstep:sandbox:remove'),
    logs: () => ipcRenderer.invoke('workstep:sandbox:logs'),
    readLogs: () => ipcRenderer.invoke('workstep:sandbox:readLogs'),
    copyLogs: () => ipcRenderer.invoke('workstep:sandbox:copyLogs'),
  },
  notify: (notice) => ipcRenderer.send('workstep:notify', notice),
})
