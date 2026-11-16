import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=path.resolve(import.meta.dirname,'..'),out=path.resolve(root,'../../tmp/digital-person-home/voice-browser')
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.join(root,'tests/fixtures/digital-person-home/index.html')}}})
const html=await fs.readFile(path.join(out,'tests/fixtures/digital-person-home/index.html'))
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});const results=[]
try{for(const [width,height]of [[390,844],[1440,1024]]){
 const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.hostname!=='voice.invalid')return route.abort()
  if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}})
  if(url.pathname==='/')return route.fulfill({body:html,contentType:'text/html'})
  const file=path.resolve(out,url.pathname.replace(/^\//,''));if(!file.startsWith(out+path.sep))return route.abort()
  try{return route.fulfill({body:await fs.readFile(file),contentType:{'.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp'}[path.extname(file)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
 })
 await page.goto('https://voice.invalid/');await page.evaluate(()=>window.homeFixture.setTtsDelay(1600));await page.locator('.digital-home-microphone').click()
 await page.waitForFunction(()=>window.homeFixture.log.captures===1)
 await page.evaluate(()=>window.homeFixture.clickNoise())
 await page.waitForTimeout(1100)
 assert.equal(await page.evaluate(()=>window.homeFixture.log.sent.length),0,'short room noise is not sent')
 await page.evaluate(()=>window.homeFixture.sound(.12))
 await page.waitForFunction(()=>window.homeFixture.log.sent.length===1)
 await page.waitForFunction(()=>document.querySelector('.digital-home').dataset.state==='thinking')
 await page.evaluate(()=>{window.homeFixture.sound(.8);window.homeFixture.sound(.8)})
 assert.equal(await page.evaluate(()=>window.homeFixture.log.stops),0)
 await page.waitForFunction(()=>!window.homeFixture.isRunning())
 await page.waitForTimeout(750)
 assert.equal(await page.evaluate(()=>window.homeFixture.log.captures),1,'synthesis gap never reopens the microphone')
 assert.equal(await page.evaluate(()=>window.homeFixture.log.playbackFrames),0)
 await page.waitForFunction(()=>window.homeFixture.log.playbackFrames>0)
 await page.waitForFunction(()=>window.homeFixture.log.captures>=2)
 assert.equal(await page.evaluate(()=>window.homeFixture.log.stops),0)
 assert.equal(await page.evaluate(()=>window.homeFixture.log.sent.length),1)
 await page.locator('.digital-home-end').click()
 const audioBeforeHistory=await page.evaluate(()=>window.homeFixture.log.audio)
 await page.locator(width<=1023?'.digital-home-transcript-button':'.digital-home-dock-transcript').click()
 await page.evaluate(()=>window.homeFixture.setHistory(rows=>[...rows,{id:'inside-history',role:'assistant',content:'查看历史时不要自动朗读。',status:'running'}]))
 await page.waitForTimeout(150)
 assert.equal(await page.evaluate(()=>window.homeFixture.log.audio),audioBeforeHistory,'history list never synthesizes speech')
 await page.screenshot({path:path.resolve(out,`../history-silent-${width}.png`)})
 await page.locator('.digital-home-chat header button').click()
 await page.evaluate(()=>window.homeFixture.setHistory(rows=>rows.map(row=>row.id==='inside-history'?{...row,status:'succeeded'}:row)))
 await page.waitForTimeout(150)
 assert.equal(await page.evaluate(()=>window.homeFixture.log.audio),audioBeforeHistory,'closing history never replays its content')
 await page.screenshot({path:path.resolve(out,`../voice-guard-${width}.png`)})
 assert.deepEqual(errors,[]);results.push({width,thinkingNoiseStops:0,sends:1,resumed:true,errors});await page.close()
}console.log(JSON.stringify(results));await fs.writeFile(path.resolve(out,'../voice-browser-results.json'),JSON.stringify(results,null,2))}finally{await browser.close()}
