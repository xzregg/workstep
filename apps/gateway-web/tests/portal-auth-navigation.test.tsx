import assert from 'node:assert/strict'
import {afterEach,test} from 'node:test'
import {JSDOM, VirtualConsole} from 'jsdom'
import {MemoryRouter} from 'react-router-dom'
import {PortalAuthPage} from '../src/PortalAuthPage'
const dom=new JSDOM('<html><body></body></html>',{url:'https://gateway.test/auth',virtualConsole:new VirtualConsole()})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,Event:dom.window.Event})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
const {render,screen,fireEvent,waitFor,cleanup}=await import('@testing-library/react')
const original=globalThis.fetch
afterEach(()=>{cleanup();globalThis.fetch=original})
test('enterprise login buttons recover if navigation stays on the page',async()=>{
 let finish!: (value:Response)=>void
 globalThis.fetch=async input=>{
  const url=String(input)
  if(url.endsWith('/start')) return await new Promise<Response>(resolve=>{finish=resolve})
  if(url.endsWith('/status'))return Response.json({initialized:true})
  if(url.endsWith('/session'))return new Response(null,{status:401})
  if(url.endsWith('/identity-sources'))return Response.json({sources:[{id:'ding',provider:'dingtalk'}]})
  return Response.json({mode:'closed',password_login_enabled:true})
 }
 render(<MemoryRouter initialEntries={['/auth']}><PortalAuthPage/></MemoryRouter>)
 const button=await screen.findByRole('button',{name:'钉钉扫码登录'}) as HTMLButtonElement
 fireEvent.click(button)
 await waitFor(()=>assert.equal(button.disabled,true))
 finish(Response.json({authorization_url:'https://login.dingtalk.com/oauth2/auth?state=test'}))
 await waitFor(()=>assert.equal(button.disabled,false))
 fireEvent.click(button)
 await waitFor(()=>assert.equal(button.disabled,true))
 finish(new Response(null,{status:502}))
 await screen.findByRole('alert')
 assert.equal(button.disabled,false)
})
