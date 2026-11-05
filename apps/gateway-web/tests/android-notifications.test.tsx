import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { notifyAndroidGatewayCompletion, postAndroidCompletion } from '../src/androidNotifications'

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

test('gateway reply completion omits a null step key in the Android bridge',()=>{
 const dom=new JSDOM('',{url:'https://gateway.test/workspace/one/chat?project=Demo'})
 Object.assign(globalThis,{window:dom.window,document:dom.window.document})
 const messages:any[]=[]
 Object.assign(dom.window,{WorkStepAndroid:{postMessage:(text:string)=>messages.push(JSON.parse(text))}})
 notifyAndroidGatewayCompletion({device_id:'one',host_project_id:'p',device_name:'设备',
  task_id:'task',messageId:'reply',step_key:null,status:'succeeded'})
 assert.equal(messages.length,1)
 assert.equal(messages[0].id,'gateway/one/p:task:reply')
 assert.equal(Object.hasOwn(messages[0],'stepKey'),false)
 assert.equal(Object.hasOwn(messages[0],'workspaceUrl'),false,'collector project IDs are not workspace project names')
 dom.window.close()
})

test('new APK destinations preserve workspace names while old APK links keep scoped IDs',()=>{
 const dom=new JSDOM('',{url:'https://gateway.test/workspace/one/chat?project=Demo&session=current'})
 Object.assign(globalThis,{window:dom.window,document:dom.window.document})
 const messages:any[]=[]
 Object.assign(dom.window,{WorkStepAndroid:{postMessage:(text:string)=>messages.push(JSON.parse(text))}})
 postAndroidCompletion({type:'watch',id:'p:s:m',projectId:'p',sessionId:'s',url:'/workspace/one/chat?project=Demo&session=s'},'one')
 postAndroidCompletion({type:'notify',id:'p:s:m',projectId:'p',sessionId:'s',url:'/workspace/one/chat?project=Demo&session=s'},'one')
 assert.equal(messages[0].workspaceUrl,'/workspace/one/chat?project=Demo&session=s')
 assert.equal(messages[1].workspaceUrl,messages[0].workspaceUrl)
 assert.equal(messages[1].url,'/chat?project=gateway%2Fone%2Fp&session=s')
 postAndroidCompletion({type:'watch',id:'p:s:m',projectId:'p',url:'/workspace/two/chat?project=Demo&session=s'},'one')
 assert.equal(Object.hasOwn(messages[2],'workspaceUrl'),false)
 dom.window.close()
})
