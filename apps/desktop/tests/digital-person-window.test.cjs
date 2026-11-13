const {test}=require('node:test')
const assert=require('node:assert/strict')
const {EventEmitter}=require('node:events')
const {createDigitalPersonWindow}=require('../src/digital-person-window.cjs')
test('floating window isolates renderer and only trusted main renderer controls it',async()=>{
 const handlers=new Map(), windows=[]
 class Window extends EventEmitter {
  constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.send=(...args)=>this.sent=args;this.webContents.setWindowOpenHandler=()=>{};windows.push(this)}
  loadFile(){return Promise.resolve()} show(){} isDestroyed(){return false} close(){this.emit('closed')}
 }
 const host={webContents:{send:(name)=>host.event=name},show(){},focus(){},isMinimized:()=>false}
 const controller=createDigitalPersonWindow({BrowserWindow:Window,ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},getMain:()=>host,trusted:event=>event.sender===host.webContents})
 const sync=handlers.get('workstep:digital-person:sync')
 assert.throws(()=>sync({sender:{}},{enabled:true}),/Untrusted/)
 sync({sender:host.webContents},{enabled:true,name:'小步',role:'助手'})
 assert.equal(windows.length,1);assert.equal(windows[0].options.webPreferences.nodeIntegration,false)
 assert.equal(windows[0].options.webPreferences.sandbox,true)
 assert.throws(()=>handlers.get('workstep:digital-person:open')({sender:host.webContents}),/Untrusted/)
 handlers.get('workstep:digital-person:open')({sender:windows[0].webContents})
 assert.equal(host.event,'workstep:digital-person:open-chat')
 sync({sender:host.webContents},{enabled:false});controller.dispose()
 assert.equal(handlers.size,0)
})
