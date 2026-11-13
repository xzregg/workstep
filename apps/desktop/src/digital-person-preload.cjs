const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('avatar',{
 onState:callback=>ipcRenderer.on('workstep:digital-person:state',(_event,state)=>callback(state)),
 open:()=>ipcRenderer.invoke('workstep:digital-person:open'),
 hide:()=>ipcRenderer.invoke('workstep:digital-person:hide'),
})
