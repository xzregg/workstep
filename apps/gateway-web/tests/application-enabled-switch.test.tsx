import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { ApplicationEnabledSwitch } from '../src/ApplicationEnabledSwitch'
const dom = new JSDOM('<html><body></body></html>', {url:'https://gateway.test/admin/settings'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,Event:dom.window.Event})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
const {render,screen,fireEvent,waitFor,cleanup}=await import('@testing-library/react')
const original=globalThis.fetch
afterEach(()=>{cleanup();globalThis.fetch=original})


test('rejected switch keeps saved state and supports retry', async () => {
 let writes=0; let saved: boolean | undefined
 globalThis.fetch=async()=>++writes===1 ? new Response(null,{status:409}) : Response.json({enabled:false})
 render(<ApplicationEnabledSwitch sourceId="source" label="企业微信应用 corp" csrf="csrf" enabled onSaved={value=>{saved=value}}/>)
 const control=screen.getByRole('switch')
 fireEvent.click(control)
 await screen.findByRole('alert')
 assert.match(screen.getByRole('alert').textContent ?? '',/最后一个登录入口/)
 assert.equal(control.getAttribute('aria-checked'),'true')
 assert.equal(saved,undefined)
 fireEvent.click(control)
 await waitFor(()=>assert.equal(saved,false))
 assert.equal(writes,2)
})

test('pending switch blocks duplicate submissions and missing CSRF disables control', async () => {
 let finish!: (response: Response)=>void; let writes=0; let saved=false
 globalThis.fetch=async()=>{writes++;return new Promise(resolve=>{finish=resolve})}
 const view=render(<ApplicationEnabledSwitch sourceId="source" label="应用" csrf="csrf" enabled onSaved={()=>{saved=true}}/>)
 const control=screen.getByRole('switch')
 fireEvent.click(control);fireEvent.click(control)
 assert.equal(writes,1)
 assert.equal((control as HTMLButtonElement).disabled,true)
 assert.ok(screen.getByRole('status'))
 finish(Response.json({enabled:false}))
 await waitFor(()=>assert.equal(saved,true))
 view.rerender(<ApplicationEnabledSwitch sourceId="source" label="应用" csrf="" enabled={false} onSaved={()=>{}}/>)
 assert.equal((control as HTMLButtonElement).disabled,true)
})
