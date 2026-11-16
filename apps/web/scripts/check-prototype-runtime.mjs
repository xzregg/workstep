// Runtime inspection against an optional local bundled prototype; no app service.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
const target=process.argv[2]?path.resolve(process.argv[2]):''
const prepared=spawnSync('uv',['run','--no-sync','python','-c',`
import json,sys
from pathlib import Path
from services.html_preview import issue_ticket,prepare_editor_html,prepare_html
from services.prototype_source import HtmlSource
from workstep_gateway_protocol.html_preview import html_preview_policy
file=Path(sys.argv[1]) if sys.argv[1] else Path('/fixture/preview.html')
source=file.read_text() if sys.argv[1] else '<div id="root"></div><script>document.getElementById("root").innerHTML="<h1>Runtime heading</h1>"</script>'
doc=HtmlSource(source)
assert doc.runtime_rendered
v=issue_ticket(file,'p',editor=True,prototype=True,inspection_only=True)
base='/preview/'+v['token']+'/'
html=prepare_html(prepare_editor_html(v['token'],source,file.name,'http://prototype.test'+base))
print(json.dumps({'html':html,'token':v['token'],'entry':file.name,'policy':html_preview_policy('http://prototype.test',base).replace("; frame-ancestors 'self'",'')}))
`,target],{cwd:'../daemon',encoding:'utf8',maxBuffer:30*1024*1024})
assert.equal(prepared.status,0,prepared.stderr)
const fixture=JSON.parse(prepared.stdout)
const {chromium}=await import('../../desktop/node_modules/playwright-core/index.mjs')
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await page.addInitScript(()=>{const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const shadow=attach.call(this,options);if(this.hasAttribute('data-ws-editor-overlay'))window.__editorShadow=shadow;return shadow}})
 await page.route('**/*',route=>{
  const url=new URL(route.request().url())
  if(url.hostname!=='prototype.test')return route.abort()
  if(url.pathname.includes(fixture.token))return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':fixture.policy},body:fixture.html})
  return route.fulfill({contentType:'text/html',body:'<iframe sandbox="allow-scripts" style="width:1400px;height:950px;border:0"></iframe><script>window.messages=[];addEventListener("message",e=>{messages.push(e.data);if(e.data?.type==="ready")e.source.postMessage({source:"workstep-prototype-host",type:"mode",enabled:true},"*")})</script>'})
 })
 await page.goto('http://prototype.test/host')
 await page.locator('iframe').evaluate((frame,f)=>frame.src='/preview/'+f.token+'/'+f.entry,fixture)
 const heading=page.frameLocator('iframe').locator('h1').first()
 await heading.waitFor({timeout:20000})
 await heading.click()
 await page.waitForFunction(()=>window.messages.some(m=>m.type==='select'))
 const selection=await page.evaluate(()=>window.messages.filter(m=>m.type==='select').at(-1).selection)
 assert.equal(selection.node_id,null,'runtime DOM is never mapped to static source offsets')
 assert.ok(selection.selector&&selection.text)
 const overlay=await heading.evaluate(()=>({box:window.__editorShadow.querySelector('.selected').getAttribute('style'),host:document.querySelector('[data-ws-editor-overlay]')?.getAttribute('style')}))
 assert.ok(overlay.box.includes('display: block'),'selection outline is shown')
 await page.keyboard.press('Delete')
 assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit').length),0,'runtime point selection does not emit direct source patches')
 await fs.mkdir('../../tmp/prototype-runtime-inspection',{recursive:true})
 await heading.click()
 await page.screenshot({path:'../../tmp/prototype-runtime-inspection/selected.png'})
 console.log('Runtime inspection: rendered heading, element selector and text, read-only source mapping passed: '+selection.text)
}finally{await browser.close()}
