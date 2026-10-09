import assert from 'node:assert/strict'
import { afterEach,test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { PortalHeader } from '../src/PortalHeader'
import { ProjectsPage } from '../src/ProjectsPage'

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://gateway.test/'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,
  MutationObserver:dom.window.MutationObserver,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
const {render,screen,fireEvent,waitFor,cleanup}=await import('@testing-library/react')
const originalFetch=globalThis.fetch
const originalSocket=globalThis.WebSocket
const originalSubmit=dom.window.HTMLFormElement.prototype.submit
afterEach(()=>{cleanup();globalThis.fetch=originalFetch;globalThis.WebSocket=originalSocket;dom.window.HTMLFormElement.prototype.submit=originalSubmit})

test('notification opens the source workspace directly and never creates iframe',async()=>{
  const sockets:FakeSocket[]=[]
  class FakeSocket {
    readyState=1;onopen:any;onclose:any;onmessage:any;onerror:any
    constructor(public url:string){sockets.push(this)}
    close(){this.readyState=3}
    send(){}
  }
  globalThis.WebSocket=FakeSocket as unknown as typeof WebSocket
  const submissions:{target:string;next:string}[]=[]
  dom.window.HTMLFormElement.prototype.submit=function(){submissions.push({target:this.target,next:new dom.window.FormData(this).get('next')?.toString()??''})}
  const snapshot={events:[{id:'event',sequence:7,device_id:'b',device_name:'B设备',host_project_id:'project',
    project_name:'演示项目',scope_name:'完成测试',task_id:'task',status:'succeeded',occurred_at:Date.now()/1000,read:false}],unread:1,cursor:7,more:false}
  let reads=0
  globalThis.fetch=async(input,init)=>{
    const url=String(input)
    if(url==='/api/auth/session')return Response.json({user:{id:'u'},csrf_token:'csrf'})
    if(url==='/api/devices')return Response.json({devices:[{id:'a',name:'A设备',online:true},{id:'b',name:'B设备',online:true}]})
    if(url==='/api/projects')return Response.json({projects:[]})
    if(url==='/api/notifications')return Response.json(snapshot)
    if(url==='/api/notifications/read'){reads++;assert.equal(new Headers(init?.headers).get('X-CSRF-Token'),'csrf');assert.equal(init?.body,'{"through":7}');return Response.json({ok:true})}
    if(url==='/api/notifications/7/access')return Response.json({url:'https://gateway.test/workspace/b/',ticket:'ticket',next:'tasks?project=Demo&task=task'})
    if(url.endsWith('/access'))return Response.json({url:'https://gateway.test/workspace/'+url.split('/')[3]+'/',ticket:'ticket'})
    throw Error('Unexpected '+url)
  }
  render(<MemoryRouter><PortalHeader signedIn hasAdminAccess={false}/><ProjectsPage/></MemoryRouter>)
  await waitFor(()=>assert.equal(submissions.length,1))
  assert.equal(sockets.length,1)
  assert.ok(sockets[0].url.endsWith('/ws/notifications'))
  fireEvent.click(screen.getByRole('tab',{name:/B设备/}))
  await waitFor(()=>assert.equal(submissions.length,2))
  fireEvent.click(screen.getByRole('tab',{name:/A设备/}))
  await waitFor(()=>assert.equal(submissions.length,3))
  assert.equal(sockets.length,1)
  fireEvent.click(screen.getByRole('button',{name:'通知，1 条未读'}))
  assert.ok(screen.getByText('B设备 · 演示项目'))
  fireEvent.click(screen.getByRole('button',{name:/完成测试 · 已完成/}))
  await waitFor(()=>assert.equal(submissions.length,4))
  assert.equal(submissions[3].next,'tasks?project=Demo&task=task')
  assert.equal(submissions[3].target,'')
  assert.equal(document.querySelector('iframe'),null)
  assert.equal(sockets.length,1)
  fireEvent.click(screen.getByRole('button',{name:'通知，1 条未读'}))
  fireEvent.click(screen.getByRole('button',{name:'全部已读'}))
  await waitFor(()=>assert.equal(reads,1))
  await screen.findByRole('button',{name:'通知，0 条未读'})
})

test('offline notification remains visible and retryable instead of navigating',async()=>{
  const snapshot={events:[{id:'event',sequence:1,device_id:'b',device_name:'B设备',project_name:'Demo',task_id:'task',status:'failed',occurred_at:1,read:false}],unread:1,cursor:1,more:false}
  globalThis.fetch=async input=>String(input)==='/api/notifications'?Response.json(snapshot):new Response(null,{status:409})
  render(<MemoryRouter><PortalHeader signedIn hasAdminAccess={false}/></MemoryRouter>)
  await screen.findByRole('button',{name:'通知，1 条未读'})
  fireEvent.click(screen.getByRole('button',{name:'通知，1 条未读'}))
  fireEvent.click(screen.getByRole('button',{name:/任务 task · 失败/}))
  await screen.findByText('设备离线，通知已保留，上线后可重试。')
  assert.equal(screen.getByRole('button',{name:'通知，1 条未读'}).getAttribute('aria-expanded'),'true')
})

test('gateway completion calls the shipped Android notify bridge once and does not replay old history',async()=>{
 const sockets:any[]=[],messages:any[]=[]
 class Socket {
  readyState=1;onopen:any;onclose:any;onmessage:any;onerror:any
  constructor(){sockets.push(this)} close(){this.readyState=3} send(){}
 }
 globalThis.WebSocket=Socket as unknown as typeof WebSocket
 Object.assign(window,{WorkStepAndroid:{postMessage:(raw:string)=>messages.push(JSON.parse(raw))}})
 const event={id:'e',sequence:1,device_id:'b',device_name:'B设备',host_project_id:'p',project_name:'Demo',
  task_id:'t',messageId:'m',status:'succeeded',occurred_at:1,read:false}
 globalThis.fetch=async()=>Response.json({events:[],unread:0,cursor:0,more:false})
 try {
  render(<MemoryRouter><PortalHeader signedIn hasAdminAccess={false}/></MemoryRouter>)
  const initial={type:'notifications',events:[event],unread:1,cursor:1,more:false}
  sockets[0].onmessage({data:JSON.stringify(initial)})
  assert.equal(messages.length,0)
  sockets[0].onmessage({data:JSON.stringify({...initial,events:[{...event,sequence:2,messageId:'new',occurred_at:Date.now()/1000}],cursor:2})})
  await waitFor(()=>assert.equal(messages.length,1))
  assert.equal(messages[0].type,'notify')
  assert.equal(messages[0].id,'gateway/b/p:t:new')
  assert.equal(messages[0].outcome,'succeeded')
  assert.equal(new URL(messages[0].url,'https://gateway.test').searchParams.get('project'),'gateway/b/p')
  sockets[0].onmessage({data:JSON.stringify({...initial,cursor:2})})
  assert.equal(messages.length,1)
 }finally{delete (window as any).WorkStepAndroid}
})
