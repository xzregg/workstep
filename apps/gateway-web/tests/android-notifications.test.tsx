import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { postAndroidCompletion } from '../src/androidNotifications'

test('old APK bridge keeps its message shape while scoping watches, project resets and targets to the device',()=>{
 const dom=new JSDOM('',{url:'https://gateway.test/workspace/one/tasks?project=Demo'})
 Object.assign(globalThis,{window:dom.window,document:dom.window.document})
 const messages:any[]=[]
 Object.assign(dom.window,{WorkStepAndroid:{postMessage:(text:string)=>messages.push(JSON.parse(text))}})
 postAndroidCompletion({type:'project',projectId:'p'},'one')
 postAndroidCompletion({type:'watch',id:'p:t:m',projectId:'p',taskId:'t',scopeName:'Task',url:'/tasks?project=Demo&task=t'},'one')
 postAndroidCompletion({type:'unwatch',id:'p:t:m'},'one')
 assert.equal(messages[0].projectId,'gateway/one/p')
 assert.equal(messages[1].id,'gateway/one/p:t:m')
 assert.equal(messages[1].taskId,'t')
 assert.equal(new URL(messages[1].url,'https://gateway.test').searchParams.get('project'),'gateway/one/p')
 assert.equal(messages[2].id,messages[1].id)
 postAndroidCompletion({type:'watch',id:'p:t:m',projectId:'p',taskId:'t'},'two')
 assert.notEqual(messages[3].id,messages[1].id)
 postAndroidCompletion({type:'watch',id:'p:t:m',projectId:'p',taskId:'t'})
 assert.equal(messages[4].id,'p:t:m')
 postAndroidCompletion({type:'notify',id:'p:t:m',projectId:'p',taskId:'t',outcome:'succeeded',url:'/workspace/two/tasks?project=Demo&task=t'},'two')
 assert.equal(new URL(messages[5].url,'https://gateway.test').pathname,'/tasks')
 dom.window.close()
})
