import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AccountPage } from '../src/AccountPage'
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://gateway.test/account'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,Event:dom.window.Event})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
const {render,screen,fireEvent,waitFor,cleanup} = await import('@testing-library/react')
const originalFetch=globalThis.fetch
afterEach(()=>{cleanup();globalThis.fetch=originalFetch})
const totals={event_count:12,unmetered_count:1,input_tokens:100,output_tokens:50,total_tokens:150,cache_read_tokens:0,cache_write_tokens:0,estimated_cost:null,billed_cost:null,currency:null}
const usage={summary:totals,daily:[{value:'2026-10-29',...totals}],models:[{value:'demo-model',...totals}]}

test('user center starts with own usage and keeps security edits when switching tabs',async()=>{
 const reads:string[]=[]
 let saved:unknown
 globalThis.fetch=async(input,init)=>{
  const url=String(input)
  if(url==='/api/auth/password'){saved=JSON.parse(String(init?.body));return Response.json({})}
  reads.push(url)
  if(url==='/api/auth/session')return Response.json({user:{id:'alice',username:'alice',display_name:'Alice'},csrf_token:'csrf'})
  if(url.startsWith('/api/account/usage'))return Response.json(usage)
  throw Error(url)
 }
 render(<MemoryRouter><AccountPage/></MemoryRouter>)
 await screen.findByRole('heading',{name:'用户中心'})
 await screen.findByText('demo-model')
 assert.equal(screen.queryByLabelText('当前密码'),null)
 assert.equal(reads.filter(url=>url.includes('/usage')).length,1)
 fireEvent.click(screen.getByRole('tab',{name:'安全设置'}))
 fireEvent.change(screen.getByLabelText('当前密码'),{target:{value:'OldPassphrase-2026!'}})
 fireEvent.change(screen.getByLabelText('新密码（至少 8 位）'),{target:{value:'NewPassphrase-2026!'}})
 fireEvent.change(screen.getByLabelText('确认新密码'),{target:{value:'NewPassphrase-2026!'}})
 fireEvent.click(screen.getByRole('tab',{name:'用量概览'}))
 fireEvent.click(screen.getByRole('tab',{name:'安全设置'}))
 assert.equal((screen.getByLabelText('当前密码') as HTMLInputElement).value,'OldPassphrase-2026!')
 fireEvent.click(screen.getByRole('button',{name:'保存新密码'}))
 await screen.findByText('密码已更新，其他登录会话已失效。')
 assert.deepEqual(saved,{current_password:'OldPassphrase-2026!',new_password:'NewPassphrase-2026!'})
 assert.equal(reads.filter(url=>url.includes('/usage')).length,1)
})

test('usage period refresh has an actionable error and does not request administrator statistics',async()=>{
 const reads:string[]=[];let failed=true
 globalThis.fetch=async(input)=>{
  const url=String(input);reads.push(url)
  if(url==='/api/auth/session')return Response.json({user:{username:'alice',display_name:'Alice'},csrf_token:'csrf'})
  return failed?new Response('{}',{status:500}):Response.json(usage)
 }
 render(<MemoryRouter><AccountPage/></MemoryRouter>)
 await screen.findByText('用量加载失败，请重试。')
 failed=false;fireEvent.click(screen.getByRole('button',{name:'重试用量'}))
 await screen.findByText('demo-model')
 fireEvent.click(screen.getByRole('button',{name:'近 7 天'}))
 await waitFor(()=>assert.ok(reads.includes('/api/account/usage?days=7')))
 assert.ok(reads.every(url=>!url.startsWith('/api/admin/')))
})
