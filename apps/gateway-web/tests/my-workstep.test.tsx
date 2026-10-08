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

test('workspace shows device sidebar and projects, filters by device, and keeps offline opening disabled',async()=>{
 const calls:string[]=[]
 globalThis.fetch=async input=>{
  const url=String(input);calls.push(url)
  if(url==='/api/auth/session')return Response.json({user:{id:'u'}})
  if(url==='/api/devices')return Response.json({devices:[{id:'d',name:'研发电脑',online:true},{id:'e',name:'离线电脑',online:false}]})
  if(url==='/api/projects')return Response.json({projects:[{id:'p',name:'演示项目',device_id:'d',device_name:'研发电脑',device_online:true,access_level:'edit',grant_sources:['个人授权']}]})
  if(url==='/api/devices/e/access')throw Error('Offline device must not be requested')
  throw Error(url)
 }
 render(<MemoryRouter><ProjectsPage/></MemoryRouter>)
 await screen.findByText('演示项目')
 assert.ok(screen.getByRole('heading',{name:'我的 WorkStep'}))
 assert.equal(calls.filter(url=>url==='/api/auth/session').length,1)
 fireEvent.click(screen.getByRole('button',{name:'离线电脑'}))
 await waitFor(()=>assert.equal(screen.queryByText('演示项目'),null))
 assert.equal((screen.getByRole('button',{name:'打开 WorkStep'}) as HTMLButtonElement).disabled,true)
 fireEvent.click(screen.getByRole('button',{name:'研发电脑'}))
 await screen.findByText('演示项目')
 assert.equal((screen.getByRole('button',{name:'打开 WorkStep'}) as HTMLButtonElement).disabled,false)
})

test('workspace opens a device through the ticket form and allows retry after an offline response',async()=>{
 let opens=0;let redeemed=''
 dom.window.HTMLFormElement.prototype.submit=function(){redeemed=this.action+'|'+(this.querySelector('input[name=ticket]') as HTMLInputElement).value}
 globalThis.fetch=async input=>{
  const url=String(input)
  if(url==='/api/auth/session')return Response.json({user:{id:'u'}})
  if(url==='/api/devices')return Response.json({devices:[{id:'d',name:'演示设备',online:true}]})
  if(url==='/api/projects')return Response.json({projects:[]})
  if(url==='/api/devices/d/access')return ++opens===1?new Response(null,{status:409}):Response.json({url:'https://d-demo.gateway.test/',ticket:'test-ticket'})
  throw Error(url)
 }
 render(<MemoryRouter><ProjectsPage/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:'演示设备'}))
 fireEvent.click(screen.getByRole('button',{name:'打开 WorkStep'}))
 await screen.findByRole('alert')
 fireEvent.click(screen.getByRole('button',{name:'打开 WorkStep'}))
 await waitFor(()=>assert.equal(redeemed,'https://d-demo.gateway.test/api/remote/redeem|test-ticket'))
 assert.equal(opens,2)
 assert.equal(document.querySelector('form'),null)
})
