import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import PrototypeEditor from '../src/components/prototype/PrototypeEditor'
import { usePrototypeStore } from '../src/stores/prototypeStore'

const workspace = {id:'a'.repeat(32), path:'index.html', root:'.', status:'idle', pending:false, error:'', bytes:20,
  history:[{id:'revision-1',label:'文字: index.html',changes:{'index.html':{before:'08',after:'9'}}}], files:['index.html','detail.html','assets/common.css'], documents:[{id:'first',path:'index.html'},{id:'second',path:'detail.html'}]}
const selection = {node_id:'n2',tag:'button',text:'Second',version:'v1',styles:{color:'rgb(0, 0, 0)',width:'100px'},ancestors:[],rect:{x:10,y:20,width:100,height:30}}

test('prototype editor selects exact nodes, posts versioned edits, switches documents and sends comments', async () => {
  const {window} = installDomEnvironment()
  useLocaleStore.setState({locale:'zh-CN'})
  const previousFetch = globalThis.fetch
  const calls: {path:string;body:Record<string,unknown>;query:string|null}[] = []
  let failChatOnce = true
  let renderVersion = 'v1'
  let undoExhausted=false
  let documentGate:Promise<void>|null=null
  let releaseDocument:()=>void=()=>{}
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input),'http://localhost')
    const body = options?.body ? JSON.parse(String(options.body)) : {}
    calls.push({path:url.pathname, body,query:url.searchParams.get('path')})
    if(url.pathname.endsWith('/document')&&documentGate)await documentGate
    let result:unknown = {}
    if(url.pathname.endsWith('/open')||url.pathname.endsWith('/edit')||url.pathname.endsWith('/undo')) result = undoExhausted?{...workspace,history:workspace.history.map(item=>({...item,undone:true}))}:workspace
    else if(url.pathname.endsWith('/document')) result = {version:renderVersion,nodes:{n2:{editable:true,text_editable:true,source:'<button>Second</button>',line:1}},html_preview:{token:'ticket-'+renderVersion,entry:url.searchParams.get('path')}}
    else if(url.pathname.endsWith('/diff')) result = {diff:'@@ -1 +1 @@\n-Before\n+After\n'}
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
    assert.equal(document.querySelector('.prototype-tree'),null,'file tree is collapsed initially')
    const directory=document.querySelector<HTMLButtonElement>('.prototype-toolbar button[aria-label="文件目录"]')!
    assert.ok(directory,'preview toolbar exposes the file tree')
    assert.equal(directory.getAttribute('aria-expanded'),'false')
    const undo = document.querySelector<HTMLButtonElement>('.prototype-toolbar button[aria-label="撤销"]')!
    assert.ok(undo, 'undo is available in the preview toolbar')
    await act(async()=>undo.click())
    assert.equal(calls.filter(call=>call.path.endsWith('/undo')).length,1)
    const undoKey=()=>new window.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true})
    await act(async()=>undo.dispatchEvent(undoKey()))
    assert.equal(calls.filter(call=>call.path.endsWith('/undo')).length,2,'Ctrl+Z undoes from editor controls')
    const input=document.querySelector('textarea')!
    await act(async()=>input.dispatchEvent(undoKey()))
    assert.equal(calls.filter(call=>call.path.endsWith('/undo')).length,2,'text fields keep native undo')
    const preview=document.querySelector('iframe')!
    const requestUndo=()=>window.dispatchEvent(new window.MessageEvent('message',{source:preview.contentWindow,data:{source:'workstep-prototype',token:'ticket-v1',type:'undo-request',version:'v1'}}))
    await act(async()=>{requestUndo();requestUndo()})
    assert.equal(calls.filter(call=>call.path.endsWith('/undo')).length,3,'iframe undo is current and duplicate requests are locked')
    const modes = document.querySelector('[role="group"].prototype-mode-switch')!
    assert.ok(modes, 'browse and select share one segmented control')
    assert.equal(modes.querySelectorAll('button').length, 2)
    const browse = [...modes.querySelectorAll('button')].find(button=>button.textContent==='浏览')!
    await act(async()=>browse.click())
    assert.equal(browse.getAttribute('aria-pressed'), 'true')
    assert.ok(calls.some(call=>call.path.endsWith('/document')))
    documentGate=new Promise(resolve=>{releaseDocument=resolve})
    await click('点选')
    const browsingFrame=document.querySelector('iframe')!
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:browsingFrame.contentWindow,data:{source:'workstep-prototype',token:'ticket-v1',type:'edit',version:'v1',node_id:'n2',operation:'text',values:{text:'FORGED DURING MODE SWITCH'}}})))
    assert.equal(calls.filter(call=>call.path.endsWith('/edit')).length,0,'old browse scripts cannot edit while the safe editor document is loading')
    await act(async()=>{documentGate=null;releaseDocument();await new Promise(resolve=>setTimeout(resolve,0))})
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
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:frame.contentWindow,data:{source:'workstep-prototype',token:'ticket-v1',type:'select',version:'v1',selection}})))
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:frame.contentWindow,data:{source:'workstep-prototype',token:'old-browse-ticket',type:'edit',version:'v1',node_id:'n2',operation:'text',values:{text:'FORGED OLD TICKET'}}})))
    assert.equal(calls.filter(call=>call.path.endsWith('/edit')).length,0,'old ticket cannot write even when source hash matches')
    const width = document.querySelector<HTMLInputElement>('input[aria-label="width"]')!
    assert.ok(width)
    const previewMessages:Record<string,unknown>[]=[]
    frame.contentWindow!.postMessage=(message:Record<string,unknown>)=>{previewMessages.push(message)}
    const setWidth=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!
    const picker=document.querySelector<HTMLInputElement>('input[aria-label="color picker"]')!
    await act(async()=>{setWidth.call(picker,'#ff0000');picker.dispatchEvent(new window.Event('input',{bubbles:true}))})
    assert.ok(previewMessages.some(message=>message.type==='preview-draft'&&(message.values as Record<string,string>)?.color==='#ff0000'),'native color input previews while the picker changes')
    await act(async()=>{setWidth.call(width,'180px');width.dispatchEvent(new window.Event('input',{bubbles:true}))})
    assert.equal(calls.filter(call=>call.path.endsWith('/edit')).length,0,'typing only previews, without writing the file')
    const draft=previewMessages.find(message=>message.type==='preview-draft'&&(message.values as Record<string,string>)?.width)!
    assert.ok(draft,'typing immediately sends a preview')
    assert.equal(draft.node_id,'n2')
    assert.equal(draft.version,'v1')
    assert.deepEqual(draft.values,{width:'180px'})
    await act(async()=>width.dispatchEvent(new window.FocusEvent('focusout',{bubbles:true})))
    const edited=calls.find(call=>call.path.endsWith('/edit'))!
    assert.equal(edited.body.node_id,'n2')
    assert.equal(edited.body.version,'v1')
    assert.deepEqual(edited.body.values,{width:'180px'})
    const rootSource=document.querySelector('iframe')!.src
    const childDocument={version:'child-v1',nodes:{n2:{editable:true,text_editable:true,line:1}},html_preview:{token:'ticket-v1',entry:'detail.html'}}
    const frameMessage=(message:Record<string,unknown>)=>window.dispatchEvent(new window.MessageEvent('message',{source:document.querySelector('iframe')!.contentWindow,data:{source:'workstep-prototype-frames',token:'ticket-v1',path:'detail.html',route:[0],frames:[{file:'index.html',selector:'iframe#content'}],...message}}))
    await act(async()=>frameMessage({kind:'loaded',document:childDocument}))
    await act(async()=>frameMessage({kind:'event',version:'child-v1',message:{source:'workstep-prototype',token:'ticket-v1',type:'select',version:'child-v1',selection:{...selection,version:'child-v1'}}}))
    assert.equal(document.querySelector('iframe')!.src,rootSource,'selecting child keeps outer preview intact')
    assert.equal(document.querySelector('.prototype-file span')!.textContent,'detail.html','header follows child file')
    const nestedWidth=document.querySelector<HTMLInputElement>('input[aria-label="width"]')!
    await act(async()=>{setWidth.call(nestedWidth,'123px');nestedWidth.dispatchEvent(new window.Event('input',{bubbles:true}))})
    assert.deepEqual(previewMessages.filter(message=>message.type==='preview-draft').at(-1)!.route,[0],'property preview reaches selected child')
    await act(async()=>frameMessage({kind:'event',version:'child-v1',message:{source:'workstep-prototype',token:'ticket-v1',type:'edit',version:'child-v1',node_id:'n2',operation:'text',values:{text:'Child change'}}}))
    assert.equal(calls.filter(call=>call.path.endsWith('/edit')).at(-1)!.body.path,'detail.html','child edit targets child file')
    assert.equal(document.querySelector('iframe')!.src,rootSource,'child refresh does not replace outer preview')
    assert.ok(previewMessages.some(message=>message.type==='refresh-frame'&&JSON.stringify(message.route)==='[0]'),'child refresh uses routed frame command')
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:document.querySelector('iframe')!.contentWindow,data:{source:'workstep-prototype',token:'ticket-v1',type:'select',version:'v1',selection}})))
    assert.equal(document.querySelector('.prototype-file span')!.textContent,'index.html','outer selection restores outer edit target')
    const navigate=(token:string,path:string)=>window.dispatchEvent(new window.MessageEvent('message',{source:document.querySelector('iframe')!.contentWindow,data:{source:'workstep-prototype-navigation',token,path}}))
    await act(async()=>navigate('wrong-ticket','detail.html'))
    assert.equal(document.querySelector('iframe')!.title,'index.html','wrong navigation ticket ignored')
    await act(async()=>navigate('ticket-v1','outside.html'))
    assert.equal(document.querySelector('iframe')!.title,'index.html','unregistered HTML ignored')
    await act(async()=>navigate('ticket-v1','detail.html'))
    assert.equal(document.querySelector('iframe')!.title,'detail.html','preview navigation changes the active document')
    assert.equal(document.querySelector('input[aria-label="width"]'),null,'old element selection is cleared')
    assert.ok(calls.some(call=>call.path.endsWith('/history')&&call.query==='detail.html'),'chat switches to destination document')
    const navigatedFrame=document.querySelector('iframe')!
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:navigatedFrame.contentWindow,data:{source:'workstep-prototype',token:'ticket-v1',type:'edit',node_id:'n2',operation:'text',values:{text:'New detail'},version:'v1'}})))
    assert.equal(calls.filter(call=>call.path.endsWith('/edit')).at(-1)!.body.path,'detail.html','edits target destination file')
    await click('文件目录')
    assert.equal(directory.getAttribute('aria-expanded'),'true')
    assert.equal(document.querySelectorAll('.prototype-tree [role=treeitem][aria-expanded]').length,1)
    await click('detail.html')
    assert.equal(document.querySelector('iframe')?.title,'detail.html')
    assert.equal(document.querySelector('.prototype-tree'),null,'switching files collapses the unpinned tree')
    await click('detail.html')
    await click('index.html')
    const currentFrame=document.querySelector('iframe')!
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:currentFrame.contentWindow,data:{source:'workstep-prototype',token:'ticket-v1',type:'hover',version:'v1',selection:{...selection,node_id:'n3',text:'Wrong neighbor'}}})))
    await act(async()=>document.querySelector('.prototype-comment textarea')!.dispatchEvent(new window.FocusEvent('focusin',{bubbles:true})))
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:currentFrame.contentWindow,data:{source:'workstep-prototype',token:'ticket-v1',type:'select',version:'v1',selection}})))
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:currentFrame.contentWindow,data:{source:'workstep-prototype',token:'ticket-v1',type:'hover',version:'v1',selection:{...selection,node_id:'n3',text:'Wrong neighbor'}}})))
    assert.match(document.querySelector('.prototype-comment')!.textContent!, /button Second/, 'clicked element remains the comment target')
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:currentFrame.contentWindow,data:{source:'workstep-prototype',token:'ticket-v1',type:'drag-state',version:'v1',active:true}})))
    assert.equal(document.querySelector('.prototype-comment'),null,'comments do not obstruct an element drag')
    await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:currentFrame.contentWindow,data:{source:'workstep-prototype',token:'ticket-v1',type:'drag-state',version:'v1',active:false}})))
    assert.ok(document.querySelector('.prototype-comment'))

    const comment=document.querySelector<HTMLTextAreaElement>('.prototype-comment textarea')!
    const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!
    await act(async()=>{setter.call(comment,'把这个按钮改成蓝色');comment.dispatchEvent(new window.Event('input',{bubbles:true}))})
    await act(async()=>navigate('ticket-v1','detail.html'))
    assert.equal(document.querySelector('iframe')!.title,'index.html','unsent comment blocks file navigation')
    assert.equal(document.querySelector<HTMLTextAreaElement>('.prototype-comment textarea')?.value,'把这个按钮改成蓝色','blocked navigation preserves comment and target')
    await click('发送到聊天')
    assert.equal(document.querySelector<HTMLTextAreaElement>('.prototype-comment textarea')?.value,'把这个按钮改成蓝色','failed comment stays available for retry')
    await click('发送到聊天')
    assert.equal(calls.filter(call=>call.path.endsWith('/chat')).length,2)
    const sent=calls.find(call=>call.path.endsWith('/chat'))!
    assert.ok(sent)
    assert.equal(sent.body.content,'把这个按钮改成蓝色')
    assert.equal((sent.body.selection as typeof selection).node_id,'n2')
    const user=usePrototypeStore.getState().sessions['prototype:p:index.html'].messages.find(message=>message.role==='user')!
    assert.match(user.content,/index\.html:1/)
    assert.match(user.content,/n2/)
    assert.match(user.content,/Second/)
    const readsBefore = calls.filter(call=>call.path.endsWith('/document')).length
    renderVersion='v2'
    await act(async()=>usePrototypeStore.setState(state=>({sessions:{...state.sessions,'prototype:p:index.html':{
      ...state.sessions['prototype:p:index.html'],running:false,messages:state.sessions['prototype:p:index.html'].messages.map(message=>message.role==='assistant'?{...message,status:'succeeded' as const,content:'Done'}:message),
    }}})))
    assert.ok(calls.filter(call=>call.path.endsWith('/document')).length>readsBefore,'completion refreshes the preview immediately')
    assert.match(document.querySelector('iframe')!.src,/ticket-v2/,'iframe navigates to the newly published preview')
    const columns = document.querySelector('.prototype-columns')!
    const frameBefore = document.querySelector('iframe')!
    await click('修改历史')
    const historyDialog = document.querySelector('[role="dialog"].prototype-history-dialog')
    assert.ok(historyDialog,'history opens in its own dialog')
    assert.equal(historyDialog.closest('.prototype-editor'),null,'history is outside the editor layout')
    assert.equal(document.querySelector('.prototype-columns'),columns)
    assert.equal(document.querySelector('iframe'),frameBefore)
    assert.match(historyDialog.textContent!,/After/)
    const undoCount=calls.filter(call=>call.path.endsWith('/undo')).length
    await act(async()=>historyDialog.querySelector('button')!.dispatchEvent(undoKey()))
    assert.equal(calls.filter(call=>call.path.endsWith('/undo')).length,undoCount,'history dialog does not undo the underlying editor')
    await act(async()=>historyDialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click())
    assert.equal(document.querySelector('.prototype-history-dialog'),null)
    assert.ok(document.querySelector('.prototype-editor'))
    undoExhausted=true
    await act(async()=>undo.dispatchEvent(new window.KeyboardEvent('keydown',{key:'z',metaKey:true,bubbles:true,cancelable:true})))
    assert.equal(undo.disabled,true,'undo disables when all history entries were undone')
    const count=calls.filter(call=>call.path.endsWith('/undo')).length
    await act(async()=>undo.dispatchEvent(undoKey()))
    assert.equal(calls.filter(call=>call.path.endsWith('/undo')).length,count,'exhausted shortcut does not request undo')
  } finally {
    documentGate=null;releaseDocument()
    await act(async()=>root.unmount())
    globalThis.fetch=previousFetch
    usePrototypeStore.setState({sessions:{}})
    container.remove()
    await window.happyDOM.close()
  }
})
