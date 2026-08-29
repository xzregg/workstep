const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('workstepDesktop', {
  backendUrl: process.env.WORKSTEP_BACKEND_URL,
})
