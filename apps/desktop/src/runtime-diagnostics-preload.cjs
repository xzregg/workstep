const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('runtimeDiagnosticsHost', {
  invoke: (action, value) => ipcRenderer.invoke('workstep:runtime-diagnostics', action, value),
})
