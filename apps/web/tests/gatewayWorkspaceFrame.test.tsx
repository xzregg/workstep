import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import GatewayRemoteFrame from '../src/components/GatewayRemoteFrame'
import GatewayDeviceTabs from '../src/components/GatewayDeviceTabs'
import GatewayWorkspaceLocation from '../src/components/GatewayWorkspaceLocation'
import { readWorkspaceLocation, rememberWorkspaceLocation } from '../src/utils/gatewayWorkspaceLocation'
import ResponsiveNavigation from '../src/components/ResponsiveNavigation'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { useProjectStore } from '../src/stores/projectStore'

test('workspace waits for its session and project, then removes content after session loss', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://d-device-1.localhost:8700/')
  const oldFetch = globalThis.fetch
  let fail = false
  const calls: string[] = []
  globalThis.fetch = async input => {
    const path = String(input)
    calls.push(path)
    if (path === '/api/remote/devices')return Response.json({devices:[]})
    if (path === '/api/remote/session') return fail ? Response.json({}, { status: 401 }) : Response.json({
      device_id: 'device-1', device_name: 'PC', username: 'Alice',
      gateway_url: 'http://localhost:8700/devices', project_id: 'platform-1',
      host_project_id: 'host-1', access_level: 'read', task_create: false,
    })
    if (path === '/api/project/host-1/summary') return Response.json({
      id: 'host-1', name: 'Visible', workflows: [], steps: {},
    })
    throw new Error(`Unexpected ${path}`)
  }
  useGatewaySessionStore.setState({ session: null, error: '', loading: false })
  useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><GatewayRemoteFrame>
      <div data-workspace>Full existing workspace</div>
    </GatewayRemoteFrame></I18nProvider>))
    assert.ok(element.querySelector('[data-workspace]'))
    assert.ok(calls.includes('/api/remote/session'))
    assert.ok(calls.includes('/api/project/host-1/summary'))
    assert.equal(useProjectStore.getState().activeProject?.id, 'host-1')
    assert.equal(element.querySelector('a')?.getAttribute('href'), 'http://localhost:8700/account')
    fail = true
    await act(async () => { await assert.rejects(useGatewaySessionStore.getState().load(true)) })
    // The shared session state must revoke content immediately, before the next poll.
    assert.equal(element.querySelector('[data-workspace]'), null)
  } finally {
    await act(async () => root.unmount())
    element.remove()
    globalThis.fetch = oldFetch
    useGatewaySessionStore.setState({ session: null, error: '', loading: false })
    useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
    await window.happyDOM.close()
  }
})

test('direct workspace has device Tabs and one aggregate feed, notification opens another device without iframe',async()=>{
 const {window}=installDomEnvironment()
 window.happyDOM.setURL('http://gateway.test/workspace/one/')
 const oldFetch=globalThis.fetch,oldSocket=globalThis.WebSocket,oldSubmit=window.HTMLFormElement.prototype.submit
 const sockets:any[]=[]
 class Socket {
  readyState=1;onopen:any;onmessage:any;onclose:any;onerror:any
  constructor(public url:string){sockets.push(this)}
  close(){this.readyState=3} send(){}
 }
 globalThis.WebSocket=Socket as unknown as typeof WebSocket
 let destination='',next='',manyDevices=false,onlyOne=false
 window.HTMLFormElement.prototype.submit=function(){destination=this.action;next=this.querySelector('input[name=next]')?.getAttribute('value') ?? (this.querySelector('input[name=next]') as HTMLInputElement)?.value ?? ''}
 globalThis.fetch=async input=>{
  const path=String(input)
  if(path==='/workspace/one/api/remote/session')return Response.json({device_id:'one',device_name:'One',username:'Owner',gateway_url:'http://gateway.test/',project_id:null,host_project_id:null})
  if(path==='/api/devices')return Response.json({devices:onlyOne?[{id:'one',name:'One',online:true}]:manyDevices?Array.from({length:100},(_,i)=>({id:i===0?'one':'device-'+i,name:'Device '+i,online:true})):[{id:'one',name:'One',online:true},{id:'two',name:'Two',online:true}]})
  if(path==='/api/projects')return Response.json({projects:[]})
  if(path==='/api/notifications')return Response.json({events:[{id:'e',sequence:1,device_id:'two',device_name:'Two',project_name:'Demo',task_id:'t',status:'succeeded',occurred_at:1,read:false}],unread:1,cursor:1,more:false})
  if(path==='/api/notifications/1/access')return Response.json({url:'http://gateway.test/workspace/two/',ticket:'ticket',next:'tasks?project=Demo&task=t'})
  throw Error(path)
 }
 useGatewaySessionStore.setState({session:null,error:'',loading:false})
 const element=document.body.appendChild(document.createElement('div')),root=createRoot(element)
 try {
  await act(async()=>root.render(<I18nProvider><GatewayRemoteFrame><MemoryRouter><ResponsiveNavigation title="WorkStep" onNew={()=>{}}><div data-workspace>WorkStep</div></ResponsiveNavigation></MemoryRouter></GatewayRemoteFrame></I18nProvider>))
  assert.ok(element.querySelector('[data-workspace]'))
  assert.equal(element.querySelectorAll('[role=tab]').length,2)
  assert.ok(element.querySelector('.gateway-remote-banner'))
  assert.equal(element.querySelector('[role=dialog]'),null)
  assert.equal(element.querySelector('.gateway-desktop-device-trigger'),null)
  assert.equal(element.querySelector('.gateway-remote-banner a')?.getAttribute('href'),'http://gateway.test/account')
  assert.equal(element.querySelector('iframe'),null)
  assert.equal(sockets.length,1)
  await act(async()=>element.querySelector<HTMLButtonElement>('.gateway-notification-trigger')!.click())
  await act(async()=>element.querySelector<HTMLButtonElement>('.gateway-notification-panel li button')!.click())
  assert.equal(destination,'http://gateway.test/workspace/two/api/remote/redeem')
  assert.equal(next,'tasks?project=Demo&task=t')
  assert.equal(sockets.length,1)
  await act(async()=>{window.innerWidth=390;window.dispatchEvent(new window.Event('resize'))})
  const trigger=element.querySelector<HTMLButtonElement>('.gateway-mobile-device-trigger')
  assert.ok(trigger)
  assert.ok(trigger.closest('.mobile-header'))
  assert.equal(element.querySelector('.gateway-remote-banner'),null)
  await act(async()=>trigger.click())
  assert.equal(trigger.getAttribute('aria-expanded'),'true')
  assert.ok(element.querySelector('[role=dialog]'))
  assert.ok(element.querySelector('.gateway-mobile-picker-header .gateway-notifications'))
  assert.equal(element.querySelectorAll('.gateway-tab-refresh').length,1)
  assert.ok(element.querySelector('.gateway-mobile-picker-header .gateway-tab-refresh'))
  assert.equal(element.querySelectorAll('.gateway-notifications').length,1)
  manyDevices=true
  await act(async()=>element.querySelector<HTMLButtonElement>('.gateway-mobile-picker-header .gateway-tab-refresh')!.click())
  assert.equal(element.querySelectorAll('[role=tab]').length,100)
  assert.ok(element.querySelector('.gateway-mobile-picker-header .gateway-tab-refresh'))
  assert.equal(element.querySelector('.gateway-mobile-picker-header a')?.getAttribute('href'),'http://gateway.test/account')
  await act(async()=>element.querySelector<HTMLButtonElement>('.gateway-mobile-picker-close')!.click())
  assert.equal(trigger.getAttribute('aria-expanded'),'false')
  await act(async()=>{window.innerWidth=1280;window.dispatchEvent(new window.Event('resize'))})
  assert.ok(element.querySelector('.gateway-remote-banner'))
  onlyOne=true
  await act(async()=>element.querySelector<HTMLButtonElement>('.gateway-remote-banner .gateway-tab-refresh')!.click())
  assert.equal(element.querySelectorAll('.gateway-remote-banner [role=tab]').length,1)
  assert.equal(element.querySelector('.gateway-desktop-device-trigger'),null)
 }finally{
  await act(async()=>root.unmount());element.remove();globalThis.fetch=oldFetch;globalThis.WebSocket=oldSocket;window.HTMLFormElement.prototype.submit=oldSubmit
  useGatewaySessionStore.setState({session:null,error:'',loading:false});await window.happyDOM.close()
 }
})


test('ordinary mobile Web has no gateway device entry or gateway requests', async () => {
  const { window } = installDomEnvironment()
  window.innerWidth = 390
  const oldFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async input => { calls.push(String(input)); throw Error('Unexpected gateway request') }
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><GatewayRemoteFrame><div data-workspace>Local Web</div></GatewayRemoteFrame></I18nProvider>))
    assert.ok(element.querySelector('[data-workspace]'))
    assert.equal(element.querySelector('.gateway-mobile-device-trigger'), null)
    assert.deepEqual(calls, [])
  } finally {
    await act(async () => root.unmount())
    element.remove()
    globalThis.fetch = oldFetch
    await window.happyDOM.close()
  }
})


test('device switching restores each user and device route with a fresh access ticket', async () => {
 const {window}=installDomEnvironment()
 const oldFetch=globalThis.fetch, oldSubmit=window.HTMLFormElement.prototype.submit
 const destinations:string[]=[]
 const requests:string[]=[]
 let current='one', user='alice', projectOnly=false, revoked=false, removedProject=false
 window.HTMLFormElement.prototype.submit=function(){destinations.push((this.querySelector('input[name=next]') as HTMLInputElement)?.value ?? '')}
 globalThis.fetch=async input=>{
  const path=String(input);requests.push(path)
  if(path==='/api/devices')return Response.json({devices:[{id:'one',name:'One',online:true,project_only:projectOnly},{id:'two',name:'Two',online:true}]})
  if(path==='/api/projects')return Response.json({projects:[{id:'p1',device_id:'one',name:'First'}, ...removedProject ? [] : [{id:'p2',device_id:'one',name:'Second'}]]})
  if(path.endsWith('/access') && revoked)return Response.json({}, {status:403})
  if(path.endsWith('/access'))return Response.json({url:`http://gateway.test/workspace/${current==='one'?'two':'one'}/`,ticket:'fresh-ticket'})
  throw Error(path)
 }
 let navigate:ReturnType<typeof useNavigate>
 function RouteControls(){navigate=useNavigate();return null}
 async function mount(device:string,entry:string,project:string|null=null){
  current=device;window.happyDOM.setURL(`http://gateway.test/workspace/${device}/${entry}`)
  useGatewaySessionStore.setState({session:{user_id:user,device_id:device,device_name:device,username:user,gateway_url:'http://gateway.test/',project_id:project,host_project_id:project?'host':null,access_level:project?'edit':null,task_create:true,share_create:true,can_manage_project_access:false},error:''})
  const element=document.body.appendChild(document.createElement('div')),root=createRoot(element)
  await act(async()=>root.render(<I18nProvider><MemoryRouter initialEntries={['/'+entry]}><GatewayWorkspaceLocation/><RouteControls/><GatewayDeviceTabs currentDeviceId={device} currentProjectId={project}/></MemoryRouter></I18nProvider>))
  return {element,close:async()=>{await act(async()=>root.unmount());element.remove()}}
 }
 try {
  let view=await mount('one','chat?project=Demo&session=old')
  await act(async()=>navigate!('/chat?project=Demo&session=last#message'))
  await act(async()=>view.element.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click())
  assert.equal(destinations.pop(),'') // New device has no saved page.
  await view.close()
  view=await mount('two','tasks?project=B&task=task-b')
  await act(async()=>view.element.querySelector<HTMLButtonElement>('[role=tab]')!.click())
  assert.equal(destinations.pop(),'chat?project=Demo&session=last#message')
  await view.close()
  view=await mount('one','chat?project=Demo&session=last#message')
  await act(async()=>view.element.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click())
  assert.equal(destinations.pop(),'tasks?project=B&task=task-b')
  await view.close()
  user='bob'
  view=await mount('two','')
  await act(async()=>view.element.querySelector<HTMLButtonElement>('[role=tab]')!.click())
  assert.equal(destinations.pop(),'') // Alice's links must not leak into Bob's workspace.
  await view.close()
  user='alice';projectOnly=true
  view=await mount('one','chat?project=Second&session=second','p2');await view.close()
  view=await mount('two','')
  await act(async()=>view.element.querySelector<HTMLButtonElement>('[role=tab]')!.click())
  assert.equal(requests.at(-1),'/api/projects/p2/access')
  assert.equal(destinations.pop(),'chat?project=Second&session=second')
  await view.close()
  removedProject=true
  view=await mount('two','')
  await act(async()=>view.element.querySelector<HTMLButtonElement>('[role=tab]')!.click())
  assert.equal(requests.at(-1),'/api/projects/p1/access')
  assert.equal(destinations.pop(),'') // A revoked project's link is discarded.
  await view.close()
  revoked=true
  view=await mount('two','')
  await act(async()=>view.element.querySelector<HTMLButtonElement>('[role=tab]')!.click())
  assert.equal(destinations.length,0)
  assert.ok(view.element.querySelector('[role=alert]'))
  await view.close()

 }finally{
  globalThis.fetch=oldFetch;window.HTMLFormElement.prototype.submit=oldSubmit
  useGatewaySessionStore.setState({session:null,error:'',loading:false});await window.happyDOM.close()
 }
})


test('saved device locations reject malformed and external destinations and tolerate unavailable storage', async () => {
 const {window}=installDomEnvironment()
 const key='workstep-workspace-location:'+JSON.stringify(['user','device'])
 try {
  for(const next of ['https://evil.test', '//evil.test', '../two/', 'api/project/list', 'chat/../../two/', 'chat?x=\\evil']) {
   localStorage.setItem(key,JSON.stringify({next,projectId:null}))
   assert.equal(readWorkspaceLocation('user','device'),null)
  }
  localStorage.setItem(key,'broken json')
  assert.equal(readWorkspaceLocation('user','device'),null)
  rememberWorkspaceLocation('user','device','chat?project=Demo&session=s#message',null)
  assert.deepEqual(readWorkspaceLocation('user','device'),{next:'chat?project=Demo&session=s#message',projectId:null})
  const original=globalThis.localStorage
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('Storage unavailable')}})
  try {
   assert.equal(readWorkspaceLocation('user','device'),null)
   assert.doesNotThrow(()=>rememberWorkspaceLocation('user','device','tasks?task=t',null))
  } finally {Object.defineProperty(globalThis,'localStorage',{configurable:true,writable:true,value:original})}
 }finally{await window.happyDOM.close()}
})
