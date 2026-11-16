// Isolated browser verification using the real server HTML preparation and CSP.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs/promises'
const prepared=spawnSync('uv',['run','--no-sync','python','-c',`
import json
from pathlib import Path
from services.html_preview import issue_ticket, prepare_editor_html, prepare_html
from workstep_gateway_protocol.html_preview import html_preview_policy
result={}
for editing in (False,True):
    grant=issue_ticket(Path('/fixture/pages/a.html'), 'p', root=Path('/fixture'), editor=editing, prototype=True)
    pages={name:prepare_html(prepare_editor_html(grant['token'],html,'pages/'+name+'.html')) for name,html in {
        'a':'<!doctype html><a href="b.html">Next page</a>',
        'b':'<!doctype html><p>Target B</p><a href="a.html">Back</a>'}.items()}
    result[str(editing)]={'token':grant['token'],'pages':pages,'policy':html_preview_policy('http://prototype.test','/preview/'+grant['token']+'/')}
print(json.dumps(result))
`],{cwd:'../daemon',encoding:'utf8'})
assert.equal(prepared.status,0,prepared.stderr)
const fixtures=JSON.parse(prepared.stdout)
const {chromium}=await import('../../desktop/node_modules/playwright-core/index.mjs')
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
try{
 const page=await browser.newPage()
 await page.route('http://prototype.test/**',route=>{
  const url=new URL(route.request().url())
  const fixture=Object.values(fixtures).find(item=>url.pathname.includes(item.token))
  if(!fixture)return route.fulfill({contentType:'text/html',body:'<iframe sandbox="allow-scripts" style="width:900px;height:600px"></iframe><script>window.messages=[];addEventListener("message",e=>messages.push(e.data))</script>'})
  const name=url.pathname.split('/').at(-1).replace('.html','')
  return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':fixture.policy},body:fixture.pages[name]})
 })
 await page.goto('http://prototype.test/host')
 const browse=fixtures.False
 await page.locator('iframe').evaluate((frame,token)=>frame.src='/preview/'+token+'/pages/a.html',browse.token)
 await page.waitForFunction(()=>window.messages.some(item=>item.path==='pages/a.html'))
 await page.frameLocator('iframe').getByText('Next page').click()
 await page.waitForFunction(()=>window.messages.some(item=>item.path==='pages/b.html'))
 assert.equal(await page.evaluate(()=>window.messages.filter(item=>item.source==='workstep-prototype-navigation').at(-1).token),browse.token)
 await page.frameLocator('iframe').getByText('Back',{exact:true}).click()
 await page.waitForFunction(()=>window.messages.filter(item=>item.path==='pages/a.html').length===2)
 const edit=fixtures.True
 await page.locator('iframe').evaluate((frame,token)=>frame.src='/preview/'+token+'/pages/b.html',edit.token)
 await page.waitForFunction(token=>window.messages.some(item=>item.path==='pages/b.html'&&item.token===token),edit.token)
 await page.locator('iframe').evaluate(frame=>frame.contentWindow.postMessage({source:'workstep-prototype-host',type:'mode',enabled:true},'*'))
 await page.frameLocator('iframe').getByText('Target B').click()
 await page.waitForFunction(()=>window.messages.some(item=>item.type==='select'&&item.selection.text==='Target B'))
 await fs.mkdir('../../tmp/prototype-navigation',{recursive:true})
 await page.screenshot({path:'../../tmp/prototype-navigation/destination.png'})
 console.log('Prototype navigation: real sandboxed A → B → A navigation, ticket reports and destination selection passed.')
}finally{await browser.close()}
