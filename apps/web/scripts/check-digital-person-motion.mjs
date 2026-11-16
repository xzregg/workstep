// Actual robot renderer and home; only conversation events are synthetic.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=path.resolve(import.meta.dirname,'..'),desktop=process.argv.includes('--desktop'),artifacts=path.resolve(root,'../../tmp/digital-person-motion',desktop?'desktop':'.'),out=path.join(artifacts,'browser')
await fs.mkdir(artifacts,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.join(root,'tests/fixtures/digital-person-home/index.html')}}})
const html=await fs.readFile(path.join(out,'tests/fixtures/digital-person-home/index.html'))
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']})
const context=await browser.newContext({viewport:desktop?{width:1440,height:1024}:{width:390,height:844},reducedMotion:'no-preference'})
const page=await context.newPage(),errors=[]
page.on('pageerror',e=>errors.push(e.message))
try{
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url())
  if(url.hostname!=='motion.invalid')return route.abort()
  if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}})
  if(url.pathname==='/')return route.fulfill({body:html,contentType:'text/html'})
  const filename=path.resolve(out,decodeURIComponent(url.pathname).replace(/^\//,''))
  if(!filename.startsWith(out+path.sep))return route.abort()
  try{return route.fulfill({body:await fs.readFile(filename),contentType:{'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'}[path.extname(filename)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
 })
 await page.goto('https://motion.invalid/')
 const header=await page.evaluate(()=>{
  const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,center:r.top+r.height/2}}
  return {header:box('.digital-home-header'),back:box('.digital-home-back'),identity:box('.digital-home-identity'),settings:box('.digital-home-settings')}
 })
 assert.ok(Math.abs(header.back.center-header.settings.center)<1,'header controls share a vertical center')
 assert.ok(desktop?Math.abs(header.back.right-(header.header.right-32))<1:Math.abs(header.back.left-(header.header.left+20))<1,'back anchors to the desktop right edge or mobile left edge')
 const canvas=page.locator('.digital-home-avatar canvas[data-avatar-pose]')
 await canvas.waitFor()
 const reply=page.locator('.digital-home-reply').filter({has:page.locator('.digital-person-feedback')}).first()
 const feedback=reply.locator('.digital-person-feedback button')
 assert.equal(await feedback.count(),2,'completed transcript replies expose both feedback controls')
 await page.mouse.move(0,0);await page.waitForTimeout(200)
 assert.equal(await feedback.first().evaluate(el=>getComputedStyle(el).opacity),desktop?'0':'1')
 await reply.hover();await page.waitForTimeout(200)
 assert.equal(await feedback.first().evaluate(el=>getComputedStyle(el).opacity),'1')
 await page.screenshot({path:path.join(artifacts,'history-feedback.png')})
 await page.mouse.move(0,0)

 await page.evaluate(()=>window.homeFixture.setActivity('think'))
 await page.waitForFunction(()=>document.querySelector('.digital-home-avatar canvas')?.dataset.avatarPose==='thinking')
 await page.screenshot({path:path.join(artifacts,'thinking.png')})
 const glow=[]
 for(let i=0;i<14;i++){glow.push(Number(await canvas.getAttribute('data-joint-glow')));await page.waitForTimeout(200)}
 assert.ok(Math.max(...glow)-Math.min(...glow)>.5,'joint lights breathe')
 await page.evaluate(()=>window.homeFixture.speaking(true,.8))
 await page.waitForFunction(()=>document.querySelector('.digital-home-avatar canvas')?.dataset.avatarPose==='neutral')
 await page.waitForFunction(()=>Number(document.querySelector('.digital-home-voice-background canvas')?.dataset.activity)>.9)
 assert.equal(await page.locator('.digital-home-voice-background').getAttribute('data-layers'),'2')
 await page.screenshot({path:path.join(artifacts,'speaking.png')})
 if(!desktop){
  for(const [name,width,height]of [['narrow',320,568],['landscape',844,390]]){
   await page.setViewportSize({width,height});await page.waitForTimeout(300)
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow')
   await page.screenshot({path:path.join(artifacts,`${name}-speaking.png`)})
  }
  await page.setViewportSize({width:390,height:844})
 }
 await page.evaluate(()=>window.homeFixture.speaking(false,1))
 await page.waitForFunction(()=>Number(document.querySelector('.digital-home-voice-background canvas')?.dataset.activity)<.002,{},{timeout:9000})
 const frame=await page.locator('.digital-home-voice-background canvas').getAttribute('data-frame')
 await page.waitForTimeout(300)
 assert.equal(await page.locator('.digital-home-voice-background canvas').getAttribute('data-frame'),frame,'settled background stops scheduling')
 await page.emulateMedia({reducedMotion:'reduce'})
 await page.waitForFunction(()=>document.querySelector('.digital-home-avatar canvas')?.dataset.motion==='still')
 const still=await canvas.evaluate(c=>c.toDataURL())
 await page.waitForTimeout(350)
 assert.equal(await canvas.evaluate(c=>c.toDataURL()),still)
 assert.equal(await page.evaluate(()=>window.homeFixture.log.captures),0)
 await page.goto('https://motion.invalid/?skinAvatar=1')
 await page.locator('[data-custom-avatar]').waitFor()
 await page.emulateMedia({reducedMotion:'no-preference'})
 await page.evaluate(()=>window.homeFixture.speaking(true,.8))
 await page.waitForFunction(()=>document.querySelector('[data-custom-avatar]')?.getAttribute('data-hands')==='lowered')
 await page.waitForFunction(()=>Number(document.querySelector('.digital-home-voice-background canvas')?.dataset.activity)>.8)
 assert.equal(await page.locator('.digital-home-avatar canvas').count(),0)
 await page.screenshot({path:path.join(artifacts,'custom-skin-speaking.png')})
 await page.addInitScript(()=>{const getContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(type==='webgl')return null;return getContext.call(this,type,...args)}})
 await page.goto('https://motion.invalid/')
 await page.evaluate(()=>window.homeFixture.setActivity('think'))
 await page.waitForFunction(()=>document.querySelector('.digital-home-avatar img')?.getAttribute('src')?.includes('thinking'))
 await page.screenshot({path:path.join(artifacts,'fallback-thinking.png')})
 assert.deepEqual(errors,[])
 await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify({glow,poses:['thinking','neutral'],layers:2,releaseStops:true,reducedMotion:true,customSkin:true,errors},null,2))
}finally{
 await page.close();await context.close();await browser.close()
}
console.log(JSON.stringify({passed:true,artifacts}))
