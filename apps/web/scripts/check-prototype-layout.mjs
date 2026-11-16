// Offline render of the real editor shell; does not start project services.
import '../tests/helpers/domEnv.ts'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import React, {act} from 'react'
import {createRoot} from 'react-dom/client'
import {installDomEnvironment} from '../tests/helpers/domEnv.ts'
import {I18nProvider, useLocaleStore} from '../src/i18n/index.tsx'
import FilePreviewDialog from '../src/components/FilePreviewDialog.tsx'
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '../../desktop/node_modules/playwright-core/index.mjs')
const browser = await chromium.launch({executablePath:process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const {window} = installDomEnvironment()
useLocaleStore.setState({locale:'zh-CN'})
const work={id:'a'.repeat(32),path:'tmp/demo/index.html',root:'.',status:'idle',pending:false,error:'',history:[{id:'revision-1',label:'文字: tmp/prototype-editor-sample/index.html',time:Date.parse('2026-11-16T02:30:00Z')/1000,changes:{'index.html':{before:'08',after:'9'}}}],files:['tmp/demo/index.html','tmp/demo/detail.html','apps/desktop/help.html'],documents:[{id:'1',path:'tmp/demo/index.html'},{id:'2',path:'tmp/demo/detail.html'}],bytes:100}
globalThis.fetch=async input=>{
 const url=String(input)
 const result=url.includes('/fs/preview')?{type:'text',content_type:'text/html',content:'<h1>Demo</h1>',extension:'.html',file_size:13}:url.includes('/assistant/list')?{assistants:[]}:url.includes('/provider/list')?{providers:[]}:url.includes('/diff')?{diff:'--- index.html\n+++ index.html\n@@ -1 +1 @@\n-<p class="stat-value">08</p>\n+<p class="stat-value">9</p>',files:[{path:'index.html',patch:'@@ -1 +1 @@\n-<p class="stat-value">08</p>\n+<p class="stat-value">9</p>\n'}]}:url.includes('/history')?{session_id:'prototype:demo:1',messages:[]}:url.includes('/document')?{version:'v1',nodes:{n1:{editable:true,text_editable:true,line:1}},html_preview:{token:'ticket',entry:work.path}}:work
 return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}})
}
const root=createRoot(document.body.appendChild(document.createElement('div')))
const directory=path.resolve('../../tmp/prototype-editor-feedback/screenshots')
fs.mkdirSync(directory,{recursive:true})
try {
 await act(async()=>{root.render(React.createElement(I18nProvider,null,React.createElement(FilePreviewDialog,{projectId:'demo',path:'index.html',name:'index.html',onClose(){}})));await new Promise(resolve=>setTimeout(resolve,30))})
 const edit=[...document.querySelectorAll('button')].find(button=>button.textContent==='原型编辑')
 assert.ok(edit)
 await act(async()=>{edit.click();await new Promise(resolve=>setTimeout(resolve,30))})
 assert.ok(!document.querySelector('.file-preview-backdrop'),'preview backdrop is removed')
 const iframe=document.querySelector('iframe')
 await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:iframe.contentWindow,data:{source:'workstep-prototype',token:'ticket',type:'select',version:'v1',selection:{node_id:'n1',tag:'button',text:'创建项目',styles:{color:'rgb(255, 255, 255)','background-color':'rgb(0, 113, 227)','font-size':'14px','font-weight':'500','border-radius':'10px',padding:'8px 16px',margin:'0px',width:'140px',height:'40px'},ancestors:[],rect:{x:40,y:180,width:140,height:40}}}})))
 await act(async()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='修改历史').click())
 const historyMarkup=document.querySelector('.prototype-history-backdrop').outerHTML
 await act(async()=>document.querySelector('.prototype-history-dialog button[aria-label="关闭"]').click())
 await act(async()=>document.querySelector('.prototype-toolbar button[aria-label="文件目录"]').click())
 const filesMarkup=document.querySelector('.prototype-files-anchor').outerHTML
 await act(async()=>document.querySelector('.prototype-toolbar button[aria-label="文件目录"]').click())
 const css=fs.readdirSync('dist/assets').filter(file=>file.endsWith('.css')).map(file=>fs.readFileSync('dist/assets/'+file,'utf8')).join('\n')
 for(const width of [320,390,1023,1280,1600]) {
  const page=await browser.newPage({viewport:{width,height:900}})
  await page.route('**/*',route=>route.abort())
  await page.setContent('<style>'+css+'</style>'+document.body.innerHTML)
  await page.locator('.prototype-zoom').selectOption('100')
  await page.locator('iframe').evaluate(frame=>{frame.removeAttribute('src');frame.srcdoc='<html><body style="font:16px system-ui;padding:40px;background:#f7f8fa"><h1>项目概览</h1><p>操作手册演示</p><button style="padding:10px 24px">创建项目</button></body></html>'})
  await page.frameLocator('iframe').getByRole('heading',{name:'项目概览'}).waitFor()
  const dimensions=await page.locator('.prototype-editor').evaluate(element=>({width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height,scroll:element.scrollWidth,client:element.clientWidth}))
  assert.ok(dimensions.width<=width+1,'editor fits viewport')
  assert.ok(dimensions.height<=901,'editor fits viewport height')
  assert.ok(dimensions.scroll<=dimensions.client+1,'editor has no horizontal overflow')
  if(width>1023) {
   assert.equal(await page.locator('.prototype-divider:visible').count(),2)
   const divider=page.locator('.prototype-divider').first()
   assert.equal((await divider.boundingBox()).width,1,'divider only occupies one pixel')
   assert.equal(await divider.evaluate(element=>getComputedStyle(element,'::before').left),'-4px','drag target remains wide')
   assert.equal(await page.locator('.prototype-mode-switch button').count(),2)
   assert.equal(await page.locator('.prototype-viewport-switch button').count(),2)
   assert.ok((await page.locator('.prototype-frame-wrap').boundingBox()).width>=200)
  }
  await page.screenshot({path:path.join(directory,width+'.png')})
  await page.locator('.prototype-frame-wrap').evaluate((wrap,markup)=>wrap.insertAdjacentHTML('beforebegin',markup),filesMarkup)
  assert.equal(await page.locator('.prototype-tree [role=treeitem]:not([aria-expanded])').count(),2,'only active directory files appear')
  assert.equal(await page.locator('.prototype-tree').getByText('apps',{exact:true}).count(),0,'unrelated workspace directories are hidden')
  const filesBounds=await page.locator('.prototype-tree').boundingBox()
  const toolbarBounds=await page.locator('.prototype-toolbar').boundingBox()
  assert.ok(filesBounds.y>=toolbarBounds.y+toolbarBounds.height,'file tree opens below wrapped toolbar')
  assert.ok(filesBounds.x+filesBounds.width<=width+1,'file tree fits viewport')
  await page.screenshot({path:path.join(directory,width+'-files.png')})
  await page.locator('.prototype-files-anchor').evaluate(element=>element.remove())
  const beforeHistory=await page.locator('.prototype-editor').boundingBox()
  const beforeColumns=await page.locator('.prototype-columns').boundingBox()
  await page.evaluate(markup=>document.body.insertAdjacentHTML('beforeend',markup),historyMarkup)
  assert.deepEqual(await page.locator('.prototype-editor').boundingBox(),beforeHistory,'history does not resize the editor')
  assert.deepEqual(await page.locator('.prototype-columns').boundingBox(),beforeColumns,'history does not move the columns')
  const historyBounds=await page.locator('.prototype-history-dialog').boundingBox()
  assert.ok(historyBounds.width<=width+1&&historyBounds.height<=901,'history fits the viewport')
  assert.equal(await page.locator('.prototype-history-revisions time').count(),1)
  assert.equal(await page.locator('.prototype-history-diff .git-code-cell.removed').count(),1)
  assert.equal(await page.locator('.prototype-history-diff .git-code-cell.added').count(),1)
  await page.screenshot({path:path.join(directory,width+'-history.png')})
  await page.close()
  console.log(width+': editor layout fits')
 }
 console.log('Screenshots: '+directory)
} finally {await act(async()=>root.unmount());await window.happyDOM.close();await browser.close()}
