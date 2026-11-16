import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.resolve(root,'../../tmp/digital-presence-implementation'),out=path.join(artifacts,'browser')
await fs.mkdir(artifacts,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.join(root,'tests/fixtures/digital-person-home/index.html')}}})
const html=await fs.readFile(path.join(out,'tests/fixtures/digital-person-home/index.html'))
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']})
const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[],results=[]
page.on('pageerror',e=>errors.push(e.message))
try{
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.hostname!=='presence.invalid')return route.abort()
  if(url.pathname.startsWith('/api/')){
   if(url.pathname.endsWith('/activity/records'))return route.fulfill({json:{run_total:237,delegation_total:0,checking:false,delegations:[],runs:[{id:'r1',status:'completed',summary:'整理了今天的工作安排',created_at:'2026-11-16T01:00:00Z'},{id:'r2',status:'skipped',summary:'暂无新的联系内容',created_at:'2026-11-16T00:00:00Z'}]}})
   if(url.pathname.endsWith('/faces/catalog'))return route.fulfill({json:{revision:'fixture',settings:{enabled:false,include_people:false,show_names:false},people:[]}})
   if(url.pathname.endsWith('/affect'))return route.fulfill({json:{state:{person_id:'p',name:'会话作者',affinity:68,emotion:'calm',valence:0,arousal:0,updated_at:null,history:[]}}})
   return route.fulfill({json:{}})
  }
  if(url.pathname==='/')return route.fulfill({body:html,contentType:'text/html'})
  const file=path.resolve(out,decodeURIComponent(url.pathname).replace(/^\//,''));if(!file.startsWith(out+path.sep))return route.abort()
  try{return route.fulfill({body:await fs.readFile(file),contentType:{'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'}[path.extname(file)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
 })
 for(const [name,width,height]of [['mobile',390,844],['narrow',320,640],['landscape',844,390],['desktop',1440,1024]]){
  await page.setViewportSize({width,height});await page.goto('https://presence.invalid/');await page.locator('.digital-presence-particles[data-frame]').waitFor()
  assert.equal(await page.locator('.digital-home-identity').count(),1)
  assert.match(await page.locator('.digital-home-presence-info').innerText(),/237/)
  assert.match(await page.locator('.digital-home-presence-info').innerText(),/68/)
  await page.screenshot({path:path.join(artifacts,name+'-idle.png')})
  const fits=await page.evaluate(()=>({width:document.documentElement.scrollWidth<=innerWidth,height:document.documentElement.scrollHeight<=innerHeight+1}));assert.deepEqual(fits,{width:true,height:true})
  if(name!=='landscape'){const stage=await page.locator('.digital-home-stage').boundingBox();assert.ok(Math.abs(stage.x+stage.width/2-width/2)<2,'orb stays centered')}
  const header=await page.locator('.digital-home-header').boundingBox(),back=await page.locator('.digital-home-back').boundingBox();assert.ok(width>1023?Math.abs(back.x+back.width-(width-32))<2:Math.abs(back.x-20)<2)
  assert.ok(header.height>0)
  await page.evaluate(()=>window.homeFixture.setActivity('think'));await page.waitForFunction(()=>document.querySelector('.digital-presence-particles')?.dataset.presencePhase==='thinking');await page.waitForTimeout(700);await page.screenshot({path:path.join(artifacts,name+'-thinking.png')})
  await page.evaluate(()=>window.homeFixture.speaking(true,.8));await page.waitForFunction(()=>Number(document.querySelector('.digital-presence-particles')?.dataset.level)>.5);await page.screenshot({path:path.join(artifacts,name+'-speaking.png')})
  await page.evaluate(()=>window.homeFixture.speaking(false,0));await page.evaluate(()=>window.homeFixture.setActivity('idle'))
  await page.evaluate(()=>window.keptOrb=document.querySelector('.digital-presence-particles'))
  const before=await page.locator('.digital-home-stage').boundingBox()
  if(width>1023)await page.locator('[data-recent-message="answer"]').click();else await page.locator('.digital-home-transcript-button').click()
  if(width>1023){await page.waitForTimeout(140);const middle=await page.locator('.digital-home-stage').boundingBox();assert.ok(middle.width<before.width&&middle.width>220);await page.screenshot({path:path.join(artifacts,'desktop-chat-moving.png')})}
  await page.waitForTimeout(900);if(width>1023)assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-message-id')),'answer');assert.equal(await page.locator('.digital-home-chat').isVisible(),true)
  assert.equal(await page.evaluate(()=>window.keptOrb===document.querySelector('.digital-presence-particles')),true)
  await page.screenshot({path:path.join(artifacts,name+'-chat.png')})
  await page.locator('.digital-home-chat header button').click();await page.waitForTimeout(850)
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('.digital-presence-particles')?.dataset.motion==='still');const frame=await page.locator('.digital-presence-particles').getAttribute('data-frame');await page.waitForTimeout(300);assert.equal(await page.locator('.digital-presence-particles').getAttribute('data-frame'),frame);await page.emulateMedia({reducedMotion:'no-preference'})
  assert.equal(await page.evaluate(()=>window.homeFixture.log.captures),0,'no automatic microphone')
  results.push({name,fits,orbCentered:name!=='landscape',sameOrb:true,audioFrames:true,reducedMotion:true})
 }
 await page.setViewportSize({width:390,height:844});await page.goto('https://presence.invalid/');await page.locator('[data-camera-toggle]').click();await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.srcObject);await page.evaluate(()=>window.keptStream=document.querySelector('.video-preview-media').srcObject);await page.locator('.digital-home-transcript-button').click();assert.equal(await page.evaluate(()=>window.keptStream===document.querySelector('.video-preview-media').srcObject),true);await page.screenshot({path:path.join(artifacts,'camera-chat.png')})
 await page.goto('https://presence.invalid/?skinAvatar=1');await page.locator('[data-custom-avatar]').waitFor();await page.evaluate(()=>window.homeFixture.speaking(true,.75));await page.waitForFunction(()=>Number(document.querySelector('[data-custom-avatar]')?.getAttribute('data-level'))>.7);assert.equal(await page.locator('.digital-presence-orb').count(),0);await page.screenshot({path:path.join(artifacts,'custom-skin.png')})
 await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='webgl'?null:original.call(this,kind,...args)}});await page.goto('https://presence.invalid/');await page.locator('.digital-presence-static').waitFor();await page.screenshot({path:path.join(artifacts,'fallback.png')})
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify({results,cameraPreserved:true,webglFallback:true,errors},null,2));console.log(JSON.stringify({passed:true,artifacts}))
}finally{await page.close();await context.close();await browser.close()}
