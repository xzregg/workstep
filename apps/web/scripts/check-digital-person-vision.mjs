// Production camera + settings, synthetic video device, no application server.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from '../../desktop/node_modules/playwright-core/index.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),artifacts=path.resolve(root,'../../tmp/digital-person-vision'),out=path.join(artifacts,'browser')
await fs.mkdir(artifacts,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.resolve(root,'tests/fixtures/digital-person-workspace/index.html')}}})
const html=await fs.readFile(path.join(out,'tests/fixtures/digital-person-workspace/index.html'))
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']})
const results=[]
try {
 for (const width of [320,390,1023,1024,1440]) {
  const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'}),errors=[],uploads=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url())
   if(url.hostname!=='vision.invalid')return route.abort()
   if(url.pathname.includes('/fs/upload/image')) {
    const data=route.request().postDataJSON();uploads.push(data)
    assert.match(data.data_url,/^data:image\/jpeg;base64,/)
    return route.fulfill({json:{url:'.workstep/uploads/camera-frame.jpg',filename:'camera-frame.jpg',size:100}})
   }
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{enabled:false,items:[],sessions:[],turns:[],pending_inserts:[],bots:[]}})
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html,headers:{'Permissions-Policy':url.searchParams.has('blocked')?'camera=()':'camera=(self)'}})
   const filename=path.resolve(out,decodeURIComponent(url.pathname).replace(/^\//,''))
   if(!filename.startsWith(out+path.sep))return route.abort()
   try{return route.fulfill({body:await fs.readFile(filename),contentType:{'.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'}[path.extname(filename)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
  })
  await page.goto('https://vision.invalid/?view=camera&blocked=1')
  await page.getByRole('alert').filter({hasText:'页面安全策略禁止使用摄像头'}).waitFor()
  assert.equal(await page.evaluate(()=>document.querySelector('video').srcObject),null)
  const blocked = await page.evaluate(async()=>{
    try { await navigator.mediaDevices.getUserMedia({video:true,audio:false}); return 'granted' }
    catch(error) { return error.name }
  })
  assert.equal(blocked,'NotAllowedError','server policy rejects before host permission')
  assert.equal(uploads.length,0)
  await page.screenshot({path:path.join(artifacts,`policy-blocked-${width}.png`),animations:'disabled'})
  await page.goto('https://vision.invalid/?view=card')
  await page.locator('[data-body-part=eyes]').click()
  await page.waitForFunction(()=>document.querySelector('video')?.videoWidth>0)
  assert.equal(await page.locator('.digital-person-vision select').count(),3)
  assert.equal(await page.getByRole('button',{name:'配置视觉模型',exact:true}).count(),0)
  const vision=page.locator('.digital-person-vision select').last()
  await vision.selectOption('demo-vl')
  assert.equal(await page.locator('.assistant-engine-vision-capability input').isChecked(),true)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  const panel=await page.locator('.digital-person-vision').boundingBox()
  for(const selector of ['.assistant-engine-panel','.digital-person-camera-preview']) {
    const bounds=await page.locator(selector).boundingBox()
    assert.ok(bounds.x>=panel.x-1 && bounds.x+bounds.width<=panel.x+panel.width+1,`${width}: ${selector} stays inside vision panel`)
  }
  await page.locator('.digital-person-vision').scrollIntoViewIfNeeded()
  await page.screenshot({path:path.join(artifacts,`vision-${width}.png`),animations:'disabled'})
  await page.goto('https://vision.invalid/?view=camera')
  await page.waitForFunction(()=>document.querySelector('video')?.videoWidth>0)
  assert.equal(uploads.length,0,'camera preview does not upload')
  const sent=await page.evaluate(()=>window.prepareCameraMessage('画面里是什么？'))
  assert.match(sent,/^画面里是什么？\n\n!\[camera-\d+.jpg\]\(\.workstep\/uploads\/camera-frame.jpg\)$/)
  assert.equal(uploads.length,1)
  assert.equal(uploads[0].prefix,'digital-person-camera')
  await page.getByRole('button',{name:'关闭摄像头',exact:true}).click()
  assert.equal(await page.evaluate(()=>document.querySelector('video').srcObject),null)
  assert.equal(await page.evaluate(()=>window.prepareCameraMessage('纯文字')),'纯文字')
  assert.equal(uploads.length,1)
  await page.goto('https://vision.invalid/?composerCamera=1')
  const camera=page.locator('.digital-person-camera--menu')
  assert.equal(await page.locator('[data-camera-toggle]').count(),0,'no standalone camera entry')
  await page.locator('.chat-input-attach').click()
  await page.getByRole('button',{name:'打开摄像头',exact:true}).click()
  assert.equal(await page.locator('.chat-input-attach-menu').count(),0,'menu closes after opening camera')
  await page.waitForFunction(()=>document.querySelector('.digital-person-camera--menu video')?.videoWidth>0)
  if(width<=1023) {
   const panel=camera.locator('.video-preview-window')
   const before=await panel.boundingBox()
   assert.ok(before.x+before.width<=width-8 && before.y<=32,`${width}: preview starts at top right`)
   const video=await camera.locator('video').boundingBox()
   for(const button of await panel.getByRole('button').all()) {
    const box=await button.boundingBox()
    assert.ok(box.y+box.height<=video.y || box.y>=video.y+video.height || box.x+box.width<=video.x || box.x>=video.x+video.width,`${width}: camera buttons stay outside video ${JSON.stringify({box,video})}`)
   }
   await page.mouse.move(video.x+20,video.y+60)
   await page.mouse.down()
   await page.mouse.move(video.x-30,video.y+140,{steps:5})
   await page.mouse.up()
   const after=await panel.boundingBox()
   assert.ok(after.x<before.x && after.y>before.y,`${width}: preview body drags`)
   await page.evaluate(()=>document.documentElement.style.setProperty('--font-scale','1.3'))
   await page.screenshot({path:path.join(artifacts,`composer-large-font-${width}.png`),animations:'disabled'})
   await page.evaluate(()=>document.documentElement.style.removeProperty('--font-scale'))
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.screenshot({path:path.join(artifacts,`composer-${width}.png`),animations:'disabled'})
  const beforeSend=uploads.length
  await page.locator('.chat-input-editor textarea').fill('看看这个')
  await page.locator('.chat-input-send').click()
  await page.waitForFunction(()=>window.workspaceFixture.lastSent?.includes('camera-'))
  assert.match(await page.evaluate(()=>window.workspaceFixture.lastSent),/^看看这个\n\n!\[camera-/)
  assert.equal(uploads.length,beforeSend+1,'shared composer uploads exactly one frame on send')
  await camera.getByRole('button',{name:'切换摄像头',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.digital-person-camera--menu')?.dataset.cameraPhase==='on')
  await page.locator('.chat-input-attach').click()
  await page.locator('[data-camera-menu-toggle]').click()
  assert.equal(await camera.locator('video').evaluate(video=>video.srcObject),null)
  await page.locator('.chat-input-attach').click()
  await page.getByRole('button',{name:'打开摄像头',exact:true}).waitFor()
  await page.screenshot({path:path.join(artifacts,`composer-menu-${width}.png`),animations:'disabled'})
  assert.deepEqual(errors,[])
  results.push({width,passed:true});await page.close()
 }
}finally{await browser.close()}
await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify(results,null,2))
console.log(JSON.stringify(results))
