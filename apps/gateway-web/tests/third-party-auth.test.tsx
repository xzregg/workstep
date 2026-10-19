import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { ThirdPartyAuthorizePage } from '../src/ThirdPartyAuthorizePage'
import { ThirdPartyAuthSettings } from '../src/ThirdPartyAuthSettings'
import { PortalAuthPage } from '../src/PortalAuthPage'
import { AdminPlatformSettingsPage } from '../src/AdminPlatformSettingsPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://gateway.test/auth/authorize'})
Object.assign(globalThis, {window:dom.window, document:dom.window.document,
 HTMLElement:dom.window.HTMLElement, MutationObserver:dom.window.MutationObserver, Event:dom.window.Event})
Object.defineProperty(globalThis, 'navigator', {configurable:true, value:dom.window.navigator})
const {cleanup, fireEvent, render, screen, waitFor} = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(()=>{cleanup(); globalThis.fetch = originalFetch})
const callback = 'http://business.example.com/callback'
const request = {callback, state:'random-state', request_id:'0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'}
const path = '/auth/authorize?' + new URLSearchParams(request)
function Location(){return <p data-testid="location">{useLocation().pathname + useLocation().search}</p>}

test('logged-in authorization validates callback, sends CSRF and redirects only the issued result', async()=>{
 const calls:string[]=[]; let redirected=''
 globalThis.fetch=async(input,init)=>{
  const url=String(input); calls.push(url)
  if(url.endsWith('/validate')){assert.deepEqual(JSON.parse(String(init?.body)),request); return Response.json({valid:true})}
  if(url.endsWith('/session'))return Response.json({csrf_token:'csrf'})
  assert.equal(url,'/api/auth/third-party/authorize')
  assert.equal(new Headers(init?.headers).get('X-CSRF-Token'),'csrf')
  assert.deepEqual(JSON.parse(String(init?.body)),request)
  return Response.json({callback_url:callback+'?code=issued&state=random-state'})
 }
 render(<MemoryRouter initialEntries={[path]}><ThirdPartyAuthorizePage onAuthorized={value=>{redirected=value}}/></MemoryRouter>)
 await waitFor(()=>assert.equal(redirected,callback+'?code=issued&state=random-state'))
 assert.deepEqual(calls,['/api/auth/third-party/validate','/api/auth/session','/api/auth/third-party/authorize'])
})

test('anonymous login retains every authorization parameter in the internal next path',async()=>{
 globalThis.fetch=async input=>String(input).endsWith('/validate')?Response.json({valid:true}):new Response(null,{status:401})
 render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/auth/authorize" element={<ThirdPartyAuthorizePage/>}/>
  <Route path="/auth" element={<Location/>}/>
 </Routes></MemoryRouter>)
 const target=await screen.findByTestId('location')
 assert.equal(new URLSearchParams(target.textContent!.split('?')[1]).get('next'),path)
})

test('malformed or duplicate parameters never send authorization requests',async()=>{
 let calls=0; globalThis.fetch=async()=>{calls++;return Response.json({})}
 render(<MemoryRouter initialEntries={[path+'&callback=https://evil.example/callback']}><ThirdPartyAuthorizePage/></MemoryRouter>)
 await screen.findByRole('alert')
 assert.equal(calls,0)
})

test('rejected allowlist remains on gateway and can retry without losing input',async()=>{
 let denied=true; let redirected=''
 globalThis.fetch=async input=>{
  if(String(input).endsWith('/validate'))return denied?Response.json({error:{message:'回调地址未获授权'}},{status:403}):Response.json({valid:true})
  if(String(input).endsWith('/session'))return Response.json({csrf_token:'csrf'})
  return Response.json({callback_url:callback+'?code=issued&state=random-state'})
 }
 render(<MemoryRouter initialEntries={[path]}><ThirdPartyAuthorizePage onAuthorized={value=>{redirected=value}}/></MemoryRouter>)
 await screen.findByRole('alert'); assert.equal(redirected,'')
 denied=false; fireEvent.click(screen.getByRole('button',{name:'重试'}))
 await waitFor(()=>assert.ok(redirected))
})

test('does not navigate to a mismatched callback response',async()=>{
 let redirected=''
 globalThis.fetch=async input=>String(input).endsWith('/validate')?Response.json({valid:true}):String(input).endsWith('/session')?Response.json({csrf_token:'csrf'}):Response.json({callback_url:'https://evil.example/?code=x&state=random-state'})
 render(<MemoryRouter initialEntries={[path]}><ThirdPartyAuthorizePage onAuthorized={value=>{redirected=value}}/></MemoryRouter>)
 await screen.findByRole('alert'); assert.equal(redirected,'')
})

test('settings load once, validate HTTP URLs, protect edits and retain a failed save for retry',async()=>{
 let reads=0;let writes=0
 globalThis.fetch=async(input,init)=>{
  if(String(input)==='/api/auth/step-up')return Response.json({})
  assert.equal(String(input),'/api/admin/third-party-auth-settings')
  if(init?.method!=='PUT'){reads++;return Response.json({callback_urls:[]})}
  assert.equal(new Headers(init?.headers).get('X-CSRF-Token'),'csrf')
  assert.deepEqual(JSON.parse(String(init?.body)),{callback_urls:[callback]})
  return ++writes===1?new Response(null,{status:503}):Response.json({callback_urls:[callback]})
 }
 render(<ThirdPartyAuthSettings csrf="csrf"/>)
 fireEvent.click(await screen.findByRole('button',{name:'修改回调白名单'}))
 const input=screen.getByLabelText('允许的回调 URL')
 fireEvent.change(input,{target:{value:'javascript:bad'}})
 assert.equal((screen.getByRole('button',{name:'保存白名单'}) as HTMLButtonElement).disabled,true)
 fireEvent.change(input,{target:{value:callback}})
 fireEvent.click(screen.getByRole('button',{name:'取消'}))
 const discard=screen.getByRole('dialog',{name:'放弃白名单修改'})
 fireEvent.click(discard.querySelector('button')!)
 fireEvent.change(screen.getByLabelText('管理员密码'),{target:{value:'password'}})
 fireEvent.click(screen.getByRole('button',{name:'保存白名单'}))
 await screen.findByRole('alert')
 assert.equal((input as HTMLTextAreaElement).value,callback)
 fireEvent.click(screen.getByRole('button',{name:'保存白名单'}))
 await waitFor(()=>assert.equal(screen.queryByRole('dialog'),null))
 assert.ok(screen.getByText(callback));assert.equal(reads,1);assert.equal(writes,2)
})

test('password login completes the original third-party authorization',async()=>{
 let loggedIn=false;let redirected=''
 globalThis.fetch=async(input,init)=>{
  const url=String(input)
  if(url.endsWith('/validate'))return Response.json({valid:true})
  if(url.endsWith('/status'))return Response.json({initialized:true})
  if(url.endsWith('/session'))return loggedIn?Response.json({csrf_token:'csrf'}):new Response(null,{status:401})
  if(url.endsWith('/identity-sources'))return Response.json({sources:[]})
  if(url.endsWith('/registration-policy'))return Response.json({mode:'closed',password_login_enabled:true})
  if(url.endsWith('/login')){assert.deepEqual(JSON.parse(String(init?.body)),{username:'alice',password:'password'});loggedIn=true;return Response.json({})}
  if(url.endsWith('/authorize'))return Response.json({callback_url:callback+'?code=password-code&state=random-state'})
  throw Error('Unexpected request: '+url)
 }
 render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/auth/authorize" element={<ThirdPartyAuthorizePage onAuthorized={value=>{redirected=value}}/>}/>
  <Route path="/auth" element={<PortalAuthPage/>}/>
 </Routes></MemoryRouter>)
 fireEvent.change(await screen.findByLabelText('用户名'),{target:{value:'alice'}})
 fireEvent.change(screen.getByLabelText('密码'),{target:{value:'password'}})
 fireEvent.click(screen.getByRole('button',{name:'登录'}))
 await waitFor(()=>assert.equal(redirected,callback+'?code=password-code&state=random-state'))
})

test('pending password login keeps the original third-party next path',async()=>{
 globalThis.fetch=async input=>{
  const url=String(input)
  if(url.endsWith('/status'))return Response.json({initialized:true})
  if(url.endsWith('/session'))return new Response(null,{status:401})
  if(url.endsWith('/identity-sources'))return Response.json({sources:[]})
  if(url.endsWith('/login'))return Response.json({user:{status:'pending'}},{status:202})
  return Response.json({mode:'closed',password_login_enabled:true})
 }
 render(<MemoryRouter initialEntries={['/auth?next='+encodeURIComponent(path)]}><Routes>
  <Route path="/auth" element={<PortalAuthPage/>}/>
  <Route path="/auth/pending" element={<Location/>}/>
 </Routes></MemoryRouter>)
 fireEvent.change(await screen.findByLabelText('用户名'),{target:{value:'pending'}})
 fireEvent.change(screen.getByLabelText('密码'),{target:{value:'password'}})
 fireEvent.click(screen.getByRole('button',{name:'登录'}))
 const location=await screen.findByTestId('location')
 assert.equal(new URLSearchParams(location.textContent!.split('?')[1]).get('next'),path)
})

test('platform settings mounts third-party settings on demand and retains drafts across tabs',async()=>{
 let reads=0
 globalThis.fetch=async input=>{
  const url=String(input)
  if(url.endsWith('/platform-settings'))return Response.json({gateway_id:'test',public_origin:null,registration_mode:'closed',session_seconds:null,database:{}})
  if(url.endsWith('/third-party-auth-settings')){reads++;return Response.json({callback_urls:[]})}
  return Response.json({csrf_token:'csrf'})
 }
 render(<MemoryRouter><AdminPlatformSettingsPage/></MemoryRouter>)
 const tab=await screen.findByRole('tab',{name:'第三方登录授权'})
 assert.equal(reads,0)
 fireEvent.click(tab)
 fireEvent.click(await screen.findByRole('button',{name:'修改回调白名单'}))
 fireEvent.change(screen.getByLabelText('允许的回调 URL'),{target:{value:callback}})
 fireEvent.click(screen.getByRole('tab',{name:'平台信息'}))
 fireEvent.click(tab)
 assert.equal((screen.getByLabelText('允许的回调 URL') as HTMLTextAreaElement).value,callback)
 assert.equal(reads,1)
})
