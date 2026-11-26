const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createCalendarHost } = require('../src/calendar-host.cjs')
test('native calendar checkpoints uncertain creation, reconciles and never recreates on retry', async () => {
  const directory = path.resolve(__dirname, '../../../tmp/native-calendar/desktop-test')
  await fs.mkdir(directory, {recursive:true})
  const temporary = await fs.mkdtemp(path.join(directory, 'ledger-'))
  let invoke, creates = 0, reconcile = 0
  const host = createCalendarHost({ipcMain:{handle:(_name,handler)=>{invoke=handler},removeHandler(){}},app:{getPath:()=>temporary},shell:{},trusted:()=>true,
    invokeProvider:async input=>{
      if(input.action==='status')return {permission:'granted',calendars:[{id:'c',name:'Calendar'}]}
      if(input.action==='create'){creates++;throw new Error('lost native response after write')}
      if(input.action==='query_created'){reconcile++;return {status:'succeeded',verification:'present',system_id:'system-event'}}
      throw new Error('Unexpected provider call')
    }})
  try {
    const identity=await invoke({},'identity',{namespace:'trusted-host:user'})
    assert.equal(identity.key.length>=32,true)
    const value={namespace:'trusted-host:user',operation:{id:'operation',action:'create',calendar_id:'c'},item:{id:'day-one',draft:{content:'Meeting'},duration_minutes:30}}
    assert.equal((await invoke({},'execute',value)).status,'unknown')
    assert.equal((await invoke({},'execute',value)).status,'succeeded')
    assert.equal((await invoke({},'execute',value)).system_id,'system-event')
    assert.equal(creates,1);assert.equal(reconcile,1)
    assert.deepEqual(await invoke({},'identity',{namespace:'trusted-host:user'}),identity)
  } finally {host.dispose();await fs.rm(temporary,{recursive:true,force:true})}
})

test('untrusted frames cannot invoke the calendar bridge',async()=>{
  let invoke
  const host=createCalendarHost({ipcMain:{handle:(_,handler)=>{invoke=handler},removeHandler(){}},trusted:()=>false,app:{},shell:{}})
  await assert.rejects(invoke({},'permission',{namespace:'x'}),/Untrusted/)
  host.dispose()
})

test('waiting for a slow provider leaves the desktop event loop responsive',async()=>{
  let invoke
  const host=createCalendarHost({ipcMain:{handle:(_,handler)=>{invoke=handler},removeHandler(){}},trusted:()=>true,
    app:{getPath:()=>path.resolve(__dirname,'../../../tmp/native-calendar/slow-provider')},shell:{},
    invokeProvider:async()=>{await new Promise(resolve=>setTimeout(resolve,200));return {permission:'granted'}}})
  try{
    const pending=invoke({},'status',{namespace:'slow'})
    const start=performance.now();await new Promise(resolve=>setTimeout(resolve,25))
    assert.ok(performance.now()-start<100)
    assert.equal((await pending).permission,'granted')
  }finally{host.dispose()}
})
