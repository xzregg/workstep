import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ProjectsPage } from '../src/ProjectsPage'
import { PortalHeader } from '../src/PortalHeader'

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://gateway.test/'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,Event:dom.window.Event})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
const {cleanup,render,screen,fireEvent,waitFor}=await import('@testing-library/react')
const originalFetch=globalThis.fetch
const originalSubmit=dom.window.HTMLFormElement.prototype.submit
afterEach(()=>{cleanup();globalThis.fetch=originalFetch;dom.window.HTMLFormElement.prototype.submit=originalSubmit})

test('portal navigation consolidates devices and projects into My WorkStep',()=>{
 render(<MemoryRouter><PortalHeader hasAdminAccess/></MemoryRouter>)
 assert.equal(screen.getByRole('link',{name:'我的 WorkStep'}).getAttribute('href'),'/')
 assert.equal(screen.queryByRole('link',{name:'我的电脑'}),null)
 assert.equal(screen.queryByRole('link',{name:'我的项目'}),null)
 assert.equal(screen.queryByRole('link',{name:'用户组 Skills'}),null)
})

test('unbound workspace goes to the existing installation guide',async()=>{
 globalThis.fetch=async input=>{
  if(String(input)==='/api/auth/session')return Response.json({user:{id:'u'}})
  if(String(input)==='/api/devices')return Response.json({devices:[]})
  if(String(input)==='/api/projects')return Response.json({projects:[]})
  throw Error(String(input))
 }
 render(<MemoryRouter><Routes><Route path="/" element={<ProjectsPage/>}/><Route path="/devices/empty" element={<h2>安装 WorkStep</h2>}/></Routes></MemoryRouter>)
 await screen.findByRole('heading',{name:'安装 WorkStep'})
})

test('unauthenticated workspace redirects to the single portal login page',async()=>{
 globalThis.fetch=async input=>{
  if(String(input)==='/api/auth/session')return new Response(null,{status:401})
  throw Error(`Unexpected request: ${String(input)}`)
 }
 render(<MemoryRouter><Routes><Route path="/" element={<ProjectsPage/>}/><Route path="/auth" element={<h2>登录工作台</h2>}/></Routes></MemoryRouter>)
 await screen.findByRole('heading',{name:'登录工作台'})
 assert.equal(screen.queryByRole('heading',{name:'我的 WorkStep'}),null)
})

test('legacy initial-password flag does not block the authorized workspace',async()=>{
 const calls:string[]=[]
 globalThis.fetch=async input=>{
  const url=String(input);calls.push(url)
  if(url==='/api/auth/session')return Response.json({user:{id:'u',must_change_password:true}})
  if(url==='/api/devices')return Response.json({devices:[{id:'d',name:'已授权电脑',online:false}]})
  if(url==='/api/projects')return Response.json({projects:[]})
  throw Error(`Unexpected request: ${url}`)
 }
 render(<MemoryRouter><ProjectsPage/></MemoryRouter>)
 await screen.findByRole('tab',{name:/已授权电脑/})
 assert.ok(calls.includes('/api/devices'))
 assert.ok(calls.includes('/api/projects'))
 assert.equal(screen.queryByRole('alert'),null)
})

test('device tabs show names and open the current workspace directly without iframe',async()=>{
 const calls:string[]=[];const targets:string[]=[]
 dom.window.HTMLFormElement.prototype.submit=function(){targets.push(this.target)}
 globalThis.fetch=async input=>{
 const url=String(input);calls.push(url)
 if(url==='/api/auth/session')return Response.json({user:{id:'u'}})
 if(url==='/api/devices')return Response.json({devices:[{id:'d',name:'研发电脑',online:true},{id:'e',name:'测试服务器',online:true},{id:'off',name:'离线电脑',online:false}]})
 if(url==='/api/projects')return Response.json({projects:[]})
 if(url.endsWith('/access'))return Response.json({url:'https://gateway.test/workspace/'+url.split('/')[3]+'/',ticket:'ticket'})
 return Response.json({device_id:'d'})
 }
 render(<MemoryRouter><ProjectsPage/></MemoryRouter>)
 await waitFor(()=>assert.equal(targets.length,1))
 assert.equal(targets[0],'')
 assert.equal(document.querySelector('iframe'),null)
 assert.ok(screen.getByRole('tab',{name:/研发电脑/}))
 fireEvent.click(screen.getByRole('tab',{name:/测试服务器/}))
 await waitFor(()=>assert.equal(targets.length,2))
 assert.equal(document.querySelectorAll('iframe').length,0)
 fireEvent.click(screen.getByRole('tab',{name:/离线电脑/}))
 await screen.findByText('离线电脑 当前离线')
 assert.equal(calls.some(url=>url==='/api/devices/off/access'),false)
})

test('gateway device tabs and offline message preserve registered names including container hostnames',async()=>{
 globalThis.fetch=async input=>{
  const url=String(input)
  if(url==='/api/auth/session')return Response.json({user:{id:'u'}})
  if(url==='/api/devices')return Response.json({devices:[{id:'container',name:'93a1f068d205',online:false},{id:'workstation',name:'钊荣的电脑',online:false}]})
  if(url==='/api/projects')return Response.json({projects:[]})
  throw Error(url)
 }
 render(<MemoryRouter><ProjectsPage/></MemoryRouter>)
 await screen.findByRole('tab',{name:/93a1f068d205/})
 assert.ok(screen.getByRole('heading',{name:'93a1f068d205 当前离线'}))
 fireEvent.click(screen.getByRole('tab',{name:/钊荣的电脑/}))
 assert.ok(screen.getByRole('heading',{name:'钊荣的电脑 当前离线'}))
 assert.equal(screen.queryByText(/WorkStep 实例/),null)
})

test('the workspace directly opens the selected online device without an entry page',async()=>{
 let access=0,submitted=0
 dom.window.HTMLFormElement.prototype.submit=function(){submitted++}
 globalThis.fetch=async input=>{
  const url=String(input)
  if(url==='/api/auth/session')return Response.json({user:{id:'u'}})
  if(url==='/api/devices')return Response.json({devices:[{id:'d',name:'研发电脑',online:true}]})
  if(url==='/api/projects')return Response.json({projects:[]})
  if(url==='/api/devices/d/access'){access++;return Response.json({url:'https://gateway.test/workspace/d/',ticket:'ticket'})}
  throw Error(url)
 }
 render(<MemoryRouter initialEntries={['/devices']}><ProjectsPage/></MemoryRouter>)
 assert.ok(await screen.findByRole('tab',{name:/研发电脑/}))
 assert.equal(screen.queryByRole('button',{name:'进入设备工作台'}),null)
 await waitFor(()=>assert.equal(submitted,1))
 assert.equal(access,1)
})

test('project-only instance switches authorized projects without requesting whole-device access',async()=>{
 const calls:string[]=[]
 dom.window.HTMLFormElement.prototype.submit=function(){}
 globalThis.fetch=async input=>{
 const url=String(input);calls.push(url)
 if(url==='/api/auth/session')return Response.json({user:{id:'u'}})
 if(url==='/api/devices')return Response.json({devices:[]})
 if(url==='/api/projects')return Response.json({projects:['A1','A2'].map((name,index)=>({id:'p'+index,name,device_id:'d',device_name:'A设备',device_online:true,access_level:'edit',grant_sources:['个人授权']}))})
 if(url.endsWith('/access'))return Response.json({url:'https://gateway.test/workspace/d/',ticket:'ticket'})
 return Response.json({device_id:'d'})
 }
 render(<MemoryRouter><ProjectsPage/></MemoryRouter>)
 await waitFor(()=>assert.ok(calls.includes('/api/projects/p0/access')))
 fireEvent.click(screen.getByRole('tab',{name:'A2'}))
 await waitFor(()=>assert.ok(calls.includes('/api/projects/p1/access')))
 assert.equal(calls.some(url=>url.includes('/devices/d/access')),false)
 assert.ok(screen.getByText('仅可访问已授权项目'))
})

test('failed direct workspace access stays retryable and revoked access stops retrying',async()=>{
 let attempts=0
 dom.window.HTMLFormElement.prototype.submit=function(){}
 globalThis.fetch=async input=>{
 const url=String(input)
 if(url==='/api/auth/session')return Response.json({user:{id:'u'}})
 if(url==='/api/devices')return Response.json({devices:[{id:'d',name:'电脑',online:true}]})
 if(url==='/api/projects')return Response.json({projects:[]})
 if(url==='/api/devices/d/access')return ++attempts===1?new Response(null,{status:503}):new Response(null,{status:403})
 throw Error(url)
 }
 render(<MemoryRouter><ProjectsPage/></MemoryRouter>)
 await screen.findByText(/正在自动重连/)
 fireEvent.click(screen.getByRole('button',{name:'立即重试'}))
 await screen.findByRole('alert')
 assert.equal(attempts,2)
 assert.equal(document.querySelector('iframe'),null)
})

test('transient gateway restart automatically reissues the current device ticket',{timeout:12000},async()=>{
 let attempts=0
 dom.window.HTMLFormElement.prototype.submit=function(){}
 globalThis.fetch=async input=>{
 const url=String(input)
 if(url==='/api/auth/session')return Response.json({user:{id:'u'}})
 if(url==='/api/devices')return Response.json({devices:[{id:'d',name:'电脑',online:true}]})
 if(url==='/api/projects')return Response.json({projects:[]})
 if(url==='/api/devices/d/access')return ++attempts===1?new Response(null,{status:503}):Response.json({url:'https://gateway.test/workspace/d/',ticket:'ticket'})
 throw Error(url)
 }
 render(<MemoryRouter><ProjectsPage/></MemoryRouter>)
 await screen.findByText(/正在自动重连/)
 await waitFor(()=>assert.equal(attempts,2),{timeout:6000})
 assert.equal(screen.getByRole('tab',{name:/电脑/}).getAttribute('aria-selected'),'true')
})

test('offline device status refreshes and opens automatically when it comes online',async()=>{
 const originalTimer=globalThis.setTimeout
 globalThis.setTimeout=((callback:any,delay?:number,...args:any[])=>originalTimer(callback,delay===10000?20:delay,...args)) as typeof setTimeout
 let lists=0,access=0
 dom.window.HTMLFormElement.prototype.submit=function(){}
 globalThis.fetch=async input=>{
 const url=String(input)
 if(url==='/api/auth/session')return Response.json({user:{id:'u'}})
 if(url==='/api/devices')return Response.json({devices:[{id:'d',name:'恢复上线电脑',online:++lists>1}]})
 if(url==='/api/projects')return Response.json({projects:[]})
 if(url==='/api/devices/d/access'){access++;return Response.json({url:'https://gateway.test/workspace/d/',ticket:'ticket'})}
 throw Error(url)
 }
 try {
 render(<MemoryRouter><ProjectsPage/></MemoryRouter>)
 await waitFor(()=>assert.equal(access,1))
 assert.ok(lists>=2)
 assert.equal(screen.getByRole('tab',{name:/恢复上线电脑/}).getAttribute('aria-selected'),'true')
 } finally {cleanup();globalThis.setTimeout=originalTimer}
})
