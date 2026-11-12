import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import PrototypeEditor from '../src/components/prototype/PrototypeEditor'
import { usePrototypeStore } from '../src/stores/prototypeStore'

const workspace = {id:'a'.repeat(32), path:'index.html', root:'.', status:'idle', pending:false, error:'', bytes:20,
  history:[], files:['index.html','pages/detail.html','common.css'], documents:[{id:'first',path:'index.html'},{id:'second',path:'pages/detail.html'}]}
const selection = {node_id:'n2',tag:'button',text:'Second',version:'v1',styles:{color:'rgb(0, 0, 0)',width:'100px'},ancestors:[],rect:{x:10,y:20,width:100,height:30}}

test('prototype editor selects exact nodes, posts versioned edits, switches documents and sends comments', async () => {
  const {window} = installDomEnvironment()
  useLocaleStore.setState({locale:'zh-CN'})
  const previousFetch = globalThis.fetch
  const calls: {path:string;body:Record<string,unknown>}[] = []
  let failChatOnce = true
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input),'http://localhost')
    const body = options?.body ? JSON.parse(String(options.body)) : {}
    calls.push({path:url.pathname, body})
    let result:unknown = {}
    if(url.pathname.endsWith('/open')||url.pathname.endsWith('/edit')) result = workspace
    else if(url.pathname.endsWith('/document')) result = {version:'v1',nodes:{n2:{editable:true,text_editable:true,source:'<button>Second</button>',line:1}},html_preview:{token:'ticket',entry:url.searchParams.get('path')}}
    else if(url.pathname.endsWith('/history')) result = {session_id:'prototype:p:'+url.searchParams.get('path'),messages:[]}
    else if(url.pathname.endsWith('/assistant/list')) result = {assistants:[]}
    else if(url.pathname.endsWith('/provider/list')) result = {providers:[]}
    else if(url.pathname.endsWith('/chat')) result = {session_id:'prototype:p:index.html',turn_id:'turn',assistant_message_id:'reply',status:'queued'}
    else if(url.pathname.endsWith('/'+workspace.id)) result = workspace
    if(url.pathname.endsWith('/chat')&&failChatOnce){failChatOnce=false;return new Response(JSON.stringify({detail:'retry me'}),{status:500,headers:{'Content-Type':'application/json'}})}
    return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}})
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const click = async (text:string) => {
    const button = [...document.querySelectorAll('button')].find(button=>button.textContent===text)
    assert.ok(button,'button '+text)
    await act(async()=>button.click())
  }
  try {
    await act(async()=>{root.render(<I18nProvider><PrototypeEditor projectId="p" path="index.html" onClose={()=>{}}/></I18nProvider>);await new Promise(resolve=>setTimeout(resolve,30))})
    assert.equal(document.querySelectorAll('.prototype-divider').length,2)
    const modes = document.querySelector('[role="group"].prototype-mode-switch')!
    assert.ok(modes, 'browse and select share one segmented control')
    assert.equal(modes.querySelectorAll('button').length, 2)
    const browse = [...modes.querySelectorAll('button')].find(button=>button.textContent==='浏览')!
    await act(async()=>browse.click())
    assert.equal(browse.getAttribute('aria-pressed'), 'true')
    assert.ok(calls.some(call=>call.path.endsWith('/document')))
    await click('点选')
    const mobile = document.querySelector<HTMLButtonElement>('button[aria-label="手机预览"]')!
    assert.ok(mobile)
    await act(async()=>mobile.click())
    assert.ok(document.querySelector('.prototype-canvas--mobile'))
    await act(async()=>document.querySelector<HTMLButtonElement>('button[aria-label="桌面预览"]')!.click())
    const zoom = document.querySelector<HTMLSelectElement>('.prototype-zoom')!
    await act(async()=>{zoom.value='75';zoom.dispatchEvent(new window.Event('change',{bubbles:true}))})
    assert.equal((document.querySelector('.prototype-frame-wrap') as HTMLElement).style.getPropertyValue('--prototype-preview-scale'), '0.75')
    await act(async()=>{zoom.value='100';zoom.dispatchEvent(new window.Event('change',{bubbles:true}))})
    const frame = document.querySelector('iframe')!
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:frame.contentWindow,data:{source:'workstep-prototype',type:'select',version:'v1',selection}})))
    const width = document.querySelector<HTMLInputElement>('input[aria-label="width"]')!
    assert.ok(width)
    width.value='180px'
    await act(async()=>width.dispatchEvent(new window.FocusEvent('focusout',{bubbles:true})))
    const edited=calls.find(call=>call.path.endsWith('/edit'))!
    assert.equal(edited.body.node_id,'n2')
    assert.equal(edited.body.version,'v1')
    assert.deepEqual(edited.body.values,{width:'180px'})
    await click('index.html')
    assert.equal(document.querySelectorAll('.prototype-tree details').length,1)
    await click('detail.html')
    assert.equal(document.querySelector('iframe')?.title,'pages/detail.html')
    await click('detail.html')
    await click('index.html')
    const currentFrame=document.querySelector('iframe')!
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:currentFrame.contentWindow,data:{source:'workstep-prototype',type:'select',comment:true,version:'v1',selection}})))
    const comment=document.querySelector<HTMLTextAreaElement>('.prototype-comment textarea')!
    const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!
    await act(async()=>{setter.call(comment,'把这个按钮改成蓝色');comment.dispatchEvent(new window.Event('input',{bubbles:true}))})
    await click('发送到聊天')
    assert.equal(document.querySelector<HTMLTextAreaElement>('.prototype-comment textarea')?.value,'把这个按钮改成蓝色','failed comment stays available for retry')
    await click('发送到聊天')
    assert.equal(calls.filter(call=>call.path.endsWith('/chat')).length,2)
    const sent=calls.find(call=>call.path.endsWith('/chat'))!
    assert.ok(sent)
    assert.equal(sent.body.content,'把这个按钮改成蓝色')
    assert.equal((sent.body.selection as typeof selection).node_id,'n2')
  } finally {
    await act(async()=>root.unmount())
    globalThis.fetch=previousFetch
    usePrototypeStore.setState({sessions:{}})
    container.remove()
    await window.happyDOM.close()
  }
})
