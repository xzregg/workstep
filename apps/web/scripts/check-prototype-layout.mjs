// Offline render of the real editor shell; does not start project services.
import '../tests/helpers/domEnv.ts'
import fs from 'node:fs'
import os from 'node:os'
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
const work={id:'a'.repeat(32),path:'index.html',root:'.',status:'idle',pending:false,error:'',history:[],files:['index.html','detail.html'],documents:[{id:'1',path:'index.html'},{id:'2',path:'detail.html'}],bytes:100}
globalThis.fetch=async input=>{
 const url=String(input)
 const result=url.includes('/fs/preview')?{type:'text',content_type:'text/html',content:'<h1>Demo</h1>',extension:'.html',file_size:13}:url.includes('/assistant/list')?{assistants:[]}:url.includes('/provider/list')?{providers:[]}:url.includes('/history')?{session_id:'prototype:demo:1',messages:[]}:url.includes('/document')?{version:'v1',nodes:{n1:{editable:true,text_editable:true,line:1}},html_preview:{token:'ticket',entry:'index.html'}}:work
 return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}})
}
const root=createRoot(document.body.appendChild(document.createElement('div')))
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'workstep-prototype-'))
try {
 await act(async()=>{root.render(React.createElement(I18nProvider,null,React.createElement(FilePreviewDialog,{projectId:'demo',path:'index.html',name:'index.html',onClose(){}})));await new Promise(resolve=>setTimeout(resolve,30))})
 const edit=[...document.querySelectorAll('button')].find(button=>button.textContent==='原型编辑')
 assert.ok(edit)
 await act(async()=>{edit.click();await new Promise(resolve=>setTimeout(resolve,30))})
 assert.ok(!document.querySelector('.file-preview-backdrop'),'preview backdrop is removed')
 const iframe=document.querySelector('iframe')
 await act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source:iframe.contentWindow,data:{source:'workstep-prototype',type:'select',version:'v1',selection:{node_id:'n1',tag:'button',text:'创建项目',styles:{color:'rgb(255, 255, 255)',width:'140px',height:'40px'},ancestors:[],rect:{x:40,y:180,width:140,height:40}}}})))
 const css=fs.readdirSync('dist/assets').filter(file=>file.endsWith('.css')).map(file=>fs.readFileSync('dist/assets/'+file,'utf8')).join('\n')
 for(const width of [390,1023,1280,1600]) {
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
  await page.close()
  console.log(width+': editor layout fits')
 }
 console.log('Screenshots: '+directory)
} finally {await act(async()=>root.unmount());await window.happyDOM.close();await browser.close()}
