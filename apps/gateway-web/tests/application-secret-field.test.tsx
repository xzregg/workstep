import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { ApplicationSecretField } from '../src/ApplicationSecretField'
const dom = new JSDOM('<html><body></body></html>', {url:'https://gateway.test/admin/settings'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,Event:dom.window.Event})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
const {render,screen,fireEvent,waitFor,cleanup}=await import('@testing-library/react')
const original=globalThis.fetch
afterEach(()=>{cleanup();globalThis.fetch=original})


test('newly entered secrets can be shown and copied without fetching saved credentials', async () => {
 let copied = ''
 globalThis.fetch = async () => { throw Error('no request expected') }
 Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async(text:string)=>{copied=text}}})
 render(<ApplicationSecretField value="new-secret" onChange={()=>{}} csrf="csrf" disabled={false} />)
 assert.equal((screen.getByLabelText('应用 Secret') as HTMLInputElement).type, 'password')
 fireEvent.click(screen.getByRole('button', {name:'显示密钥'}))
 await screen.findByRole('button', {name:'隐藏密钥'})
 fireEvent.click(screen.getByRole('button', {name:'复制密钥'}))
 await screen.findByText('密钥已复制')
 assert.equal(copied, 'new-secret')
})

test('saved secret read and clipboard failures allow retry while keeping plaintext hidden', async () => {
 let requests = 0
 globalThis.fetch = async () => ++requests === 1 ? new Response(null, {status:403}) : Response.json({client_secret:'stored-secret'})
 Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async()=>{throw Error('denied')}}})
 render(<ApplicationSecretField value="" onChange={()=>{}} sourceId="source" configured csrf="csrf" disabled={false}/>)
 fireEvent.click(screen.getByRole('button', {name:'复制密钥'}))
 await screen.findByText('读取密钥失败，请检查权限或密钥配置后重试。')
 fireEvent.click(screen.getByRole('button', {name:'复制密钥'}))
 await screen.findByText('复制失败，请显示密钥后手动复制。')
 assert.equal((screen.getByLabelText('应用 Secret') as HTMLInputElement).type, 'password')
 fireEvent.click(screen.getByRole('button', {name:'显示密钥'}))
 await waitFor(() => assert.equal((screen.getByLabelText('应用 Secret') as HTMLInputElement).type, 'text'))
 assert.equal(requests, 2)
})
