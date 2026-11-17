// Shared production video window in the actual digital-person home; synthetic camera frames.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.resolve(root,'../../tmp/video-preview-window'),out=path.join(artifacts,'browser')
await fs.mkdir(artifacts,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.join(root,'tests/fixtures/digital-person-home/index.html')}}})
const html=await fs.readFile(path.join(out,'tests/fixtures/digital-person-home/index.html'))
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']})
const results=[]
const clipAudit=await fs.readFile(path.resolve(root,'../../.agents/skills/desktop-agent-ui/scripts/clip-audit.js'),'utf8')
try{
 for(const [width,height]of [[320,700],[390,844],[844,390],[1023,900],[1024,900],[1440,1024]]){
  const page=await browser.newPage({viewport:{width,height},screen:{width,height},reducedMotion:'reduce'}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url())
   if(url.hostname!=='preview.invalid')return route.abort()
   if(url.pathname.endsWith('/faces/catalog'))return route.fulfill({json:{revision:'fixture',settings:{enabled:false,include_people:false,show_names:false},people:[]}})
   if(url.pathname.endsWith('/faces/settings'))return route.fulfill({json:{settings:{enabled:false,show_names:true,include_people:true,include_relationship:true,preset:'balanced',threshold:.65},revision:0}})
   if(url.pathname.endsWith('/faces/people'))return route.fulfill({json:{items:[]}})
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}})
   if(url.pathname==='/')return route.fulfill({body:html,contentType:'text/html'})
   const filename=path.resolve(out,decodeURIComponent(url.pathname).replace(/^\//,''))
   if(!filename.startsWith(out+path.sep))return route.abort()
   try{return route.fulfill({body:await fs.readFile(filename),contentType:{'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'}[path.extname(filename)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
  })
  await page.addInitScript(()=>{
   let canvas
   Object.defineProperty(screen,'orientation',{configurable:true,value:{type:innerHeight>=innerWidth?'portrait-primary':'landscape-primary'}})
   window.videoFixture={resize:(width,height)=>{
    canvas.width=width;canvas.height=height
    const ctx=canvas.getContext('2d'),gradient=ctx.createLinearGradient(0,0,width,height)
    gradient.addColorStop(0,'#255966');gradient.addColorStop(1,'#91bd9a');ctx.fillStyle=gradient;ctx.fillRect(0,0,width,height)
    ctx.fillStyle='#e84b4b';ctx.fillRect(0,0,width*.08,height);ctx.fillStyle='#4b6ee8';ctx.fillRect(width*.92,0,width*.08,height);ctx.fillStyle='#fff';ctx.font=`${Math.round(width*.08)}px sans-serif`;ctx.fillText(`${width} × ${height}`,width*.15,height*.5)
   }}
   Object.defineProperty(navigator.mediaDevices,'getSupportedConstraints',{value:()=>({resizeMode:true})})
   Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async(constraints)=>{
    window.videoFixture.constraints=constraints
    // Reproduce an Android camera that ignores portrait constraints.
    canvas=document.createElement('canvas');window.videoFixture.resize(1280,720)
    setInterval(()=>canvas.getContext('2d').fillRect(0,0,1,1),80)
    return canvas.captureStream(30)
   }})
  })
  await page.goto('https://preview.invalid/')
  await page.locator('.digital-presence-particles[data-frame]').waitFor()
  await page.locator('.digital-home-voice-dock [data-camera-toggle]').click()
  const panel=page.locator('.video-preview-window'),video=panel.locator('video'),header=panel.locator('.video-preview-header')
  await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.videoWidth>0)
  if(width>1023){
   assert.equal(await panel.getAttribute('data-video-docked'),'true','desktop uses the fixed camera panel')
   const camera=page.locator('.digital-person-camera--panel'),cameraBox=await camera.boundingBox(),footer=await page.locator('.digital-home-footer').boundingBox(),info=await page.locator('.digital-home-presence-info').boundingBox()
   assert.ok(cameraBox.width>=320,'desktop camera is enlarged')
   assert.ok(cameraBox.y+cameraBox.height<=footer.y-8,'camera stays above bottom controls')
   assert.ok(Math.abs(cameraBox.y-info.y-info.height-16)<2,'camera sits directly below reflection metrics with a 16px gap')
   const caption=await page.locator('.digital-home-caption-frame').boundingBox();assert.ok(caption.x+caption.width<=cameraBox.x-8,'camera does not cover captions')
   const audit=await page.evaluate('('+clipAudit+')({root:".digital-home-footer"})');assert.equal(audit.cut,0,JSON.stringify(audit))
   await panel.locator('[data-video-close]').hover();const hoverAudit=await page.evaluate('('+clipAudit+')({root:".digital-home-footer"})');assert.equal(hoverAudit.cut,0,JSON.stringify(hoverAudit))
   assert.equal(await page.locator('.digital-home-camera-title').count(),0,'one shared header only')
   assert.equal(await header.locator('.video-preview-header-title').count(),1)
   assert.ok((await header.boundingBox()).height<=32,'compact shared header')
   const perception=page.locator('.digital-home-camera-perception')
   assert.equal(await perception.getByRole('button').count(),1)
   assert.match(await perception.innerText(),/人脸识别/)
   assert.doesNotMatch(await perception.innerText(),/麦克风|声音/)
  }else{
   assert.equal(await panel.getAttribute('data-video-docked'),null,'mobile restores the shared floating preview')
   assert.equal(await page.locator('.digital-person-camera--panel').count(),0)
  }
  await page.screenshot({path:path.join(artifacts,`panel-${width}-${height}.png`)})
  if(width===390){
   await page.evaluate(()=>window.videoFixture.resize(720,1280))
   await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.videoWidth===720)
   await page.waitForTimeout(80)
   const portrait=await video.boundingBox();assert.ok(Math.abs(portrait.width/portrait.height-9/16)<.02)
   await page.screenshot({path:path.join(artifacts,'panel-portrait-390-844.png')})
   await page.evaluate(()=>window.videoFixture.resize(1280,720));await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.videoWidth===1280);await page.waitForTimeout(80)
  }
  await page.evaluate(()=>{window.keptCameraElement=document.querySelector('.video-preview-media');window.keptCameraStream=window.keptCameraElement.srcObject})
  if(width>1023){
   const camera=page.locator('.digital-person-camera--panel'),before=await camera.boundingBox(),title=panel.locator('.video-preview-header-title'),titleBox=await title.boundingBox()
   await page.mouse.move(titleBox.x+40,titleBox.y+titleBox.height/2);await page.mouse.down();await page.mouse.move(titleBox.x-80,titleBox.y+titleBox.height/2-40,{steps:8});await page.mouse.up()
   const moved=await camera.boundingBox();assert.ok(Math.abs(moved.x-before.x+120)<2&&Math.abs(moved.y-before.y+40)<2,'whole white panel moves by title drag')
   const faceEntry=await page.locator('.digital-home-camera-perception').boundingBox();assert.ok(faceEntry.y>moved.y&&faceEntry.y+faceEntry.height<=moved.y+moved.height,'face entry moves with the white panel')
   await header.focus();await page.keyboard.press('ArrowLeft');assert.ok(Math.abs((await camera.boundingBox()).x-moved.x+8)<2,'keyboard moves the whole panel')
   assert.equal(await page.evaluate(()=>window.keptCameraElement===document.querySelector('.video-preview-media')&&window.keptCameraStream===document.querySelector('.video-preview-media').srcObject),true,'panel dragging preserves video and stream')
   const audit=await page.evaluate('('+clipAudit+')({root:”.digital-home-footer”})'.replaceAll('”','"'));assert.equal(audit.cut,0,JSON.stringify(audit))
   await page.screenshot({path:path.join(artifacts,`panel-dragged-${width}.png`)})
  }
  const sourceRatio=await video.evaluate(v=>v.videoWidth/v.videoHeight)
  assert.equal(await panel.locator('[data-video-pin]').count(),0,'no fixed/floating toggle')
  if(width<=1023){
  const dockedBox=await video.boundingBox()
  const pinned=await panel.evaluate(el=>{const video=el.querySelector('video'),box=video.getBoundingClientRect();return {width:box.width,height:box.height,ratio:video.videoWidth/video.videoHeight}})
  assert.ok(Math.abs(pinned.width/pinned.height-pinned.ratio)<.02,'fixed preview follows the actual frame without extra bars '+JSON.stringify({width,height,pinned}))
  assert.equal(await page.evaluate(()=>window.keptCameraElement===document.querySelector('.video-preview-media')&&window.keptCameraStream===document.querySelector('.video-preview-media').srcObject),true,'detaching keeps the actual camera session')
  const check=async()=>{
   const measured=await panel.evaluate(el=>{
    const box=el.getBoundingClientRect(),video=el.querySelector('video'),media=video.getBoundingClientRect(),eyes=document.querySelector('[data-avatar-eyes]').getBoundingClientRect()
    return {x:box.x,y:box.y,width:box.width,height:box.height,media:{x:media.x,y:media.y,width:media.width,height:media.height},ratio:video.videoWidth/video.videoHeight,fit:getComputedStyle(video).objectFit,sourceRatio:video.videoWidth/video.videoHeight,eyes:{x:eyes.x,y:eyes.y},viewport:{width:innerWidth,height:innerHeight}}
   })
   assert.ok(Math.abs(measured.media.width/measured.media.height-measured.ratio)<.015,'window follows actual video ratio')
   assert.ok(measured.x>=7&&measured.y>=7&&measured.x+measured.width<=measured.viewport.width-7&&measured.y+measured.height<=measured.viewport.height-7,'window remains inside viewport')
   return measured
  }
  const measured=await check()
  const originalSize=await panel.boundingBox()
  await video.dblclick()
  assert.equal(await panel.getAttribute('data-video-expanded'),'true','desktop double click enlarges the preview')
  await video.dblclick()
  assert.equal(await panel.getAttribute('data-video-expanded'),'false','second double click restores preview')
  assert.deepEqual(await panel.boundingBox(),originalSize)
  assert.equal(await panel.locator('[data-camera-ratio]').count(),0,'ratio switching has been removed')
  assert.equal(measured.fit,'contain','full frame is displayed without cropping');assert.ok(measured.sourceRatio>1,'fixture actually returns a landscape stream')
  assert.equal(await panel.getAttribute('data-frame-aspect'),null,'window never overrides the actual camera aspect ratio')
  assert.deepEqual(await page.evaluate(()=>window.videoFixture.constraints.video.resizeMode),{exact:'none'})
  assert.equal(await header.locator(':scope > span').count(),0,'no preview title or title bar')
  assert.equal(await panel.evaluate(el=>getComputedStyle(el).borderTopColor),'rgba(24, 24, 27, 0.72)')
  assert.deepEqual(await panel.evaluate(el=>{const s=getComputedStyle(el);return [s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius]}),['0px','0px','0px','0px'])
  const controlBox=await header.boundingBox()
  assert.ok(controlBox.y>=7 && controlBox.y+controlBox.height<=measured.media.y,'controls stay above the video inside the viewport')
  assert.ok(Math.abs(measured.media.x+measured.media.width/2-(dockedBox.x+dockedBox.width/2))<2,'detaching preserves the preview horizontal position')
  assert.ok(Math.abs(measured.media.y+measured.media.height/2-(dockedBox.y+dockedBox.height/2))<2,'detaching preserves the preview vertical position')
  for(const button of await header.getByRole('button').all()){
   const box=await button.boundingBox();assert.ok(box.height<=24&&box.y+box.height<=measured.media.y+1,'controls outside video')
  }
  assert.equal(await panel.locator('.digital-person-camera-switch svg.lucide-switch-camera').count(),1,'switch icon is outside video')
  await page.screenshot({path:path.join(artifacts,`eyes-${width}-${height}.png`)})
  if(width===390){
   const lightStyle=await page.addStyleTag({content:'.digital-home{background:#fff!important} .digital-home-main,.digital-home-footer,.digital-home-header{visibility:hidden} .video-preview-window,.video-preview-header{visibility:visible}'})
   for(const button of await header.getByRole('button').all()){assert.equal(await button.evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)','white icons contrast with the button surface');assert.equal(await button.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(24, 24, 27, 0.72)','translucent dark background keeps controls visible over both light and dark pages')}
   await page.screenshot({path:path.join(artifacts,'white-chat-camera-390-844.png')})
   await lightStyle.evaluate(el=>el.remove())
  }
  if(width===390){
   await page.setViewportSize({width:844,height:390})
   await page.evaluate(()=>{screen.orientation.type='landscape-primary';window.dispatchEvent(new Event('orientationchange'));window.videoFixture.resize(1280,720)})
   await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.videoWidth===1280)
   await page.waitForTimeout(100)
   await check()
   await page.screenshot({path:path.join(artifacts,'eyes-rotated-landscape.png')})
   await page.setViewportSize({width:390,height:844})
   await page.evaluate(()=>{screen.orientation.type='portrait-primary';window.dispatchEvent(new Event('orientationchange'));window.videoFixture.resize(1280,720)})
   await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.videoWidth===1280)
   await page.waitForTimeout(100)
   await check()
  }
  const handle=panel.locator('[data-video-resize="se"]'),grip=await handle.locator('.video-preview-resize-grip').boundingBox()
  assert.equal((await handle.boundingBox()).width,32,'visible corner has a usable drag area')
  const gripPanel=await panel.boundingBox(),bottom=gripPanel.y+gripPanel.height,right=gripPanel.x+gripPanel.width
  assert.ok(grip.y<bottom&&grip.y+grip.height>bottom&&grip.x<right&&grip.x+grip.width>right,'sharp corner grip straddles the exact bottom-right edge')
  assert.equal(await handle.locator('.video-preview-resize-grip').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','no square button background')
  assert.equal(await handle.locator('.video-preview-resize-grip').evaluate(el=>getComputedStyle(el).borderRightColor),'rgba(0, 0, 0, 0.45)')
  const resizeBefore=await panel.boundingBox(),touch=await page.context().newCDPSession(page)
  const x=grip.x+grip.width/2,y=grip.y+grip.height/2
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]})
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+40}]})
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
  assert.ok((await panel.boundingBox()).width>resizeBefore.width+5,'touching corner and dragging vertically changes size')
  await check()
  await page.screenshot({path:path.join(artifacts,`resized-${width}-${height}.png`)})
  await touch.detach()
  await page.evaluate(()=>window.videoFixture.resize(720,1280))
  await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.videoWidth===720)
  await check()
  await page.screenshot({path:path.join(artifacts,`portrait-source-${width}-${height}.png`)})
  if(width===390){
   const tap=await page.context().newCDPSession(page),box=await video.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2
   const doubleTap=async()=>{for(let i=0;i<2;i++){await tap.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await tap.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})}}
   await doubleTap()
   assert.equal(await panel.getAttribute('data-video-expanded'),'true','real touch double tap enlarges')
   await page.screenshot({path:path.join(artifacts,'double-tap-expanded.png')})
   await doubleTap()
   assert.equal(await panel.getAttribute('data-video-expanded'),'false','second touch double tap restores')
   await tap.detach()
  }
  const before=await panel.boundingBox(),media=await video.boundingBox()
  await page.mouse.move(media.x+media.width/2,media.y+media.height/2);await page.mouse.down();await page.mouse.move(media.x+media.width/2-25,media.y+media.height/2+25,{steps:5});await page.mouse.up()
  assert.notDeepEqual(await panel.boundingBox(),before,'video surface drags whole window')
  await panel.locator('[data-video-close]').click()
  assert.equal(await video.evaluate(v=>v.srcObject),null)
  if(width===390){
   // Emulate a portrait phone whose keyboard shrinks only the page viewport.
   await page.setViewportSize({width:390,height:280})
   await page.locator('.digital-home-voice-dock [data-camera-toggle]').click()
   await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.videoWidth===1280)
   await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.videoWidth===1280)
   assert.equal(await video.evaluate(v=>v.videoWidth/v.videoHeight),16/9,'fixture keeps ignoring portrait hints')
   await check()
   await check()
   assert.equal(await page.evaluate(()=>window.videoFixture.constraints.video.aspectRatio.ideal),9/16)
   await panel.locator('[data-video-close]').click()
  }
  }else await panel.locator('[data-video-close]').click()
  await page.setViewportSize({width,height})
  if(width>1023){await page.locator('.digital-home-voice-dock [data-camera-toggle]').click();await page.locator('.video-preview-window[data-video-ready="true"]').waitFor();const camera=await page.locator('.digital-person-camera--panel').boundingBox(),info=await page.locator('.digital-home-presence-info').boundingBox();assert.ok(Math.abs(camera.y-info.y-info.height-16)<2,'reopening restores default position below reflection');assert.equal(await page.locator('.digital-person-camera--panel').getAttribute('data-camera-moved'),'false');await page.locator('.digital-home-camera-perception button').click()}
  else await page.locator('.digital-home-face-entry').click()
  const faceDialog=page.locator('.face-home-panel');await faceDialog.waitFor();await faceDialog.locator('.face-panel-tabs').waitFor()
  const faceBox=await faceDialog.boundingBox();assert.ok(Math.abs(faceBox.x+faceBox.width/2-width/2)<2&&Math.abs(faceBox.y+faceBox.height/2-height/2)<2,'face recognition opens a centered dialog')
  assert.ok(faceBox.x>=8&&faceBox.y>=8&&faceBox.x+faceBox.width<=width-8&&faceBox.y+faceBox.height<=height-8,'face dialog fits viewport')
  await page.screenshot({path:path.join(artifacts,`face-dialog-${width}.png`)})
  if(width>1023){const before=await faceDialog.boundingBox(),handle=await faceDialog.locator('.resizable-panel-e').boundingBox();await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x-80,handle.y+handle.height/2);await page.mouse.up();assert.ok((await faceDialog.boundingBox()).width<before.width,'dialog supports resizing')}
  const faceAudit=await page.evaluate('('+clipAudit+')({root:”.face-home-backdrop”})'.replaceAll('”','"'));assert.equal(faceAudit.cut,0,JSON.stringify(faceAudit))
  await page.locator('.face-home-close').click();await faceDialog.waitFor({state:'detached'})
  assert.deepEqual(errors,[]);results.push({width,height,ratio:sourceRatio,toolbar:24,defaultBelowReflection:width>1023,panelDraggable:width>1023});await page.close()
 }
}finally{await browser.close()}
await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
