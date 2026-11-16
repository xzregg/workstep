// Real sandbox/CSP and native frame navigation. No WorkStep service is started.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs/promises'
const prepared=spawnSync('uv',['run','--no-sync','python','-c',`
import json
from pathlib import Path
from services.html_preview import issue_ticket, prepare_editor_html, prepare_html
from workstep_gateway_protocol.html_preview import html_preview_policy
sources={
'index.html':'<!doctype html><style>body{margin:0;font:16px system-ui}nav{position:absolute;width:140px}iframe{margin-left:150px;width:800px;height:550px;border:0}</style><nav><a href="pages/d.html" target="content">Open D</a><p id="shared">Outer</p></nav><iframe id="content" name="content" src="pages/b.html"></iframe><script>window.pageScriptRan=true</script>',
'pages/b.html':'<!doctype html><style>body{margin:20px;font:20px system-ui}iframe{width:600px;height:300px;border:3px solid #aaa}</style><p id="shared">Child B</p><iframe id="deep" src="../deep/c.html"></iframe><script>parent.postMessage({source:"workstep-prototype",type:"edit",node_id:"n1",values:{text:"FORGED"}},"*")</script>',
'pages/d.html':'<!doctype html><p id="shared">Child D</p>',
'deep/c.html':'<!doctype html><style>body{margin:20px;font:24px system-ui}</style><p id="shared">Deep C</p>'}
result={}
for editing in (False,True):
    grant=issue_ticket(Path('/fixture/index.html'),'p',root=Path('/fixture'),editor=editing,prototype=True)
    base='/preview/'+grant['token']+'/'
    def render(path,source):return prepare_html(prepare_editor_html(grant['token'],source,path,'http://prototype.test'+base))
    result[str(editing)]={'token':grant['token'],'pages':{path:render(path,source+('<meta http-equiv="refresh" content="0;url=https://external.invalid">' if editing and path=='index.html' else '')) for path,source in sources.items()},'policy':html_preview_policy('http://prototype.test',base).replace("; frame-ancestors 'self'",''),'updated':render('deep/c.html',sources['deep/c.html'].replace('Deep C','Saved C'))}
print(json.dumps(result))
`],{cwd:'../daemon',encoding:'utf8'})
assert.equal(prepared.status,0,prepared.stderr)
const fixtures=JSON.parse(prepared.stdout)
const {chromium}=await import('../../desktop/node_modules/playwright-core/index.mjs')
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
try{
 const externalRequests=[]
 const page=await browser.newPage({viewport:{width:1200,height:800}})
 page.setDefaultTimeout(6000)
 await page.route('**/*',route=>{
  const url=new URL(route.request().url())
  const fixture=Object.values(fixtures).find(item=>url.pathname.startsWith('/preview/'+item.token+'/'))
  if(url.hostname!=='prototype.test'){externalRequests.push(url.href);return route.abort()}
  if(!fixture)return route.fulfill({contentType:'text/html',body:'<iframe id="preview" sandbox="allow-scripts" style="width:1100px;height:700px;border:0"></iframe><script>window.messages=[];window.snapshots=[];window.editing=true;addEventListener("message",event=>{messages.push(event.data);if(event.source===document.querySelector("iframe").contentWindow&&event.data?.source==="workstep-prototype-frames"&&event.data.kind==="hello"){event.source.postMessage({source:"workstep-prototype-host",type:"frame-state",snapshots},"*");event.source.postMessage({source:"workstep-prototype-host",type:"mode",enabled:editing},"*")}})</script>'})
  const path=decodeURIComponent(url.pathname.slice(('/preview/'+fixture.token+'/').length))
  return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':fixture.policy},body:fixture.pages[path]||'missing'})
 })
 await page.goto('http://prototype.test/host')
 const command=data=>page.locator('#preview').evaluate((frame,data)=>frame.contentWindow.postMessage({source:'workstep-prototype-host',...data},'*'),data)
 const open=fixture=>page.locator('#preview').evaluate((frame,token)=>frame.src='/preview/'+token+'/index.html',fixture.token)
 const fixture=fixtures.True
 await open(fixture)
 const outer=page.frameLocator('#preview'),child=outer.frameLocator('#content'),deep=child.frameLocator('#deep')
 await deep.getByText('Deep C',{exact:true}).waitFor()
 await page.waitForFunction(()=>window.messages.some(item=>item.kind==='loaded'&&item.path==='deep/c.html'&&item.route.join('.')==='0.0'))
 assert.deepEqual(externalRequests,[],'meta refresh cannot replace the trusted editor with an external document')
 assert.equal(await outer.locator('body').evaluate(()=>Boolean(window.pageScriptRan)),false,'prototype scripts are paused throughout editing')
 assert.equal(await page.evaluate(()=>window.messages.filter(item=>item.message?.type==='edit').length),0,'prototype script cannot forge an edit')
 await outer.locator('#content').evaluate(frame=>{frame.style.transform='scale(.85)';frame.style.transformOrigin='top left'})
 await deep.getByText('Deep C',{exact:true}).click()
 await page.waitForFunction(()=>window.messages.some(item=>item.message?.type==='select'&&item.path==='deep/c.html'))
 const selected=await page.evaluate(()=>window.messages.filter(item=>item.message?.type==='select'&&item.path==='deep/c.html').at(-1))
 assert.deepEqual(selected.route,[0,0])
 assert.equal(selected.frames.length,2)
 const bounds=await deep.getByText('Deep C',{exact:true}).boundingBox(),rootBounds=await page.locator('#preview').boundingBox()
 assert.ok(Math.abs(selected.message.selection.rect.x-(bounds.x-rootBounds.x))<1,'nested border coordinates project into outer preview')
 await deep.locator('body').evaluate(()=>{document.body.style.height='2000px';window.scrollTo(0,40)})
 await page.waitForFunction(y=>window.messages.some(item=>item.message?.type==='selection-position'&&item.path==='deep/c.html'&&Math.abs(item.message.selection.rect.y-(y-34))<1),selected.message.selection.rect.y)
 await deep.locator('body').evaluate(()=>window.scrollTo(0,0))
 await command({type:'preview-draft',route:[0,0],node_id:selected.message.selection.node_id,version:selected.version,operation:'style',values:{color:'rgb(255, 0, 0)'}})
 assert.equal(await deep.getByText('Deep C',{exact:true}).evaluate(element=>getComputedStyle(element).color),'rgb(255, 0, 0)')
 assert.notEqual(await child.getByText('Child B',{exact:true}).evaluate(element=>getComputedStyle(element).color),'rgb(255, 0, 0)','same IDs in other files remain unchanged')
 await outer.locator('body').evaluate(()=>window.preserved=42)
 await child.locator('body').evaluate(()=>window.preserved=23)
 fixture.pages['deep/c.html']=fixture.updated
 await command({type:'refresh-frame',route:[0,0],path:'deep/c.html'})
 await deep.getByText('Saved C',{exact:true}).waitFor()
 assert.equal(await outer.locator('body').evaluate(()=>window.preserved),42,'outer document is not reloaded')
 assert.equal(await child.locator('body').evaluate(()=>window.preserved),23,'intermediate document is not reloaded')
 await fs.mkdir('../../tmp/prototype-frames',{recursive:true})
 await deep.getByText('Saved C',{exact:true}).click()
 await page.waitForFunction(version=>window.messages.some(item=>item.message?.type==='select'&&item.path==='deep/c.html'&&item.version!==version),selected.version)
 await page.screenshot({path:'../../tmp/prototype-frames/nested-edit.png'})
 // Native target navigation and restoring the chosen child when switching to edit mode.
 await page.evaluate(()=>{window.editing=false;window.messages=[]})
 await open(fixtures.False)
 await outer.getByText('Open D',{exact:true}).click()
 await child.getByText('Child D',{exact:true}).waitFor()
 await page.waitForFunction(()=>window.messages.some(item=>item.kind==='loaded'&&item.path==='pages/d.html'))
 await page.evaluate(()=>{window.editing=true;window.snapshots=[{route:[0],path:'pages/d.html'}]})
 await open(fixtures.True)
 await child.getByText('Child D',{exact:true}).waitFor()
 await child.getByText('Child D',{exact:true}).click()
 await page.waitForFunction(()=>window.messages.some(item=>item.message?.type==='select'&&item.path==='pages/d.html'))
 console.log('Prototype frames: nested selection, coordinate projection, routed live edits, child-only refresh, script isolation, target navigation and route restoration passed.')
}finally{await browser.close()}
