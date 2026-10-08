import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { ClientDownloadPage } from '../src/ClientDownloadPage'
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'http://localhost:8700/devices/empty'})
Object.assign(globalThis, {window:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, MutationObserver:dom.window.MutationObserver})
Object.defineProperty(globalThis, 'navigator', {configurable:true,value:dom.window.navigator})
const {render,screen,fireEvent,cleanup} = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(()=>{cleanup();globalThis.fetch=originalFetch})
test('installer displays and copies the saved domain instead of the browser origin', async()=>{
 let copied=''
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value}}})
 globalThis.fetch=async input=>String(input)==='/api/client-releases'?Response.json({releases:[],public_origin:'https://workstep.example.com'}):Response.json({devices:[]})
 render(<MemoryRouter><ClientDownloadPage/></MemoryRouter>)
 await screen.findByText('https://workstep.example.com')
 assert.equal(screen.queryByText('http://localhost:8700'),null)
 fireEvent.click(screen.getByRole('button',{name:'复制地址'}))
 await screen.findByText('地址已复制')
 assert.equal(copied,'https://workstep.example.com')
})
