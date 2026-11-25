import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const byId=process.argv.includes('--conversation-by-id')
const workbench=process.argv.includes('--workbench-ui-actions')
const avatarMotionOnly=process.argv.includes('--avatar-motion-only')
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.resolve(root,workbench?'../../tmp/digital-person-workbench-ui':byId?'../../tmp/digital-person-conversation-by-id':'../../tmp/digital-person-home'),out=path.join(artifacts,'browser')
await fs.mkdir(artifacts,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.join(root,'tests/fixtures/digital-person-home/index.html')}}})
const html=await fs.readFile(path.join(out,'tests/fixtures/digital-person-home/index.html'))
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']})
const results=[]
const conversationOnly=byId||process.argv.includes('--conversation-only')
try{
 for(const [width,height]of [[320,568],[320,700],[388,510],[390,844],[1023,900],[1024,900],[1440,1024]]){
  const page=await browser.newPage({viewport:{width,height}}),errors=[]
  if(workbench)page.setDefaultTimeout(8000)
  const conversationRequests=[]
  let turns=0
  page.on('pageerror',e=>errors.push(e.stack||e.message))
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url())
   if(url.hostname!=='home.invalid')return route.abort()
   if(url.pathname==='/api/fs/serve/companion-test.webp')return route.fulfill({body:await fs.readFile(path.join(root,'src/assets/digital-person-body-relaxed.webp')),contentType:'image/webp'})
   if(url.pathname==='/api/digital-person/affect')return route.fulfill({status:503,json:{detail:'Simulated unavailable relationship'}})
   if(workbench&&url.pathname==='/api/digital-person')return route.fulfill({json:{enabled:true,name:'小研'}})
   if(workbench&&url.pathname==='/api/digital-person/activity')return route.fulfill({json:{main_session_id:'main',delegations:[],runs:[],feedback:{}}})
   if(avatarMotionOnly&&url.pathname==='/api/chat-sessions/worker')return route.fulfill({json:{id:'worker',project_id:'demo',title:'构建检查',engine:'pydantic_ai',messages:[{id:'worker-message',role:'assistant',status:'succeeded',content:'模拟委派执行记录。'}]}})
   if(workbench&&url.pathname==='/api/chat-sessions/main')return route.fulfill({json:{id:'main',project_id:'demo',title:'数字中枢对话',engine:'pydantic_ai',message_count:1,messages:[{id:'old',role:'assistant',status:'succeeded',content:['```workstep-ui','{"action":"conversation.open","project_id":"p","session_id":"preview"}','```'].join('\n')}]}})
   if(workbench&&url.pathname==='/api/chat-sessions/main/chat'){
    turns++
    return route.fulfill({json:{session_id:'main',turn_id:'user-'+turns,assistant_message_id:'reply-'+turns,status:'running',engine:'pydantic_ai'}})
   }
   if(url.pathname==='/api/chat-sessions'){
    conversationRequests.push('list')
    return route.fulfill({json:{sessions:[{id:'preview',title:'发布复盘'}]}})
   }
   if(url.pathname==='/api/chat-sessions/preview'){
    conversationRequests.push(url.searchParams.get('project_id'))
    return route.fulfill({json:{id:'preview',project_id:'p',title:'发布复盘',engine:'pydantic_ai',messages:[{id:'preview-message',role:'user',status:'succeeded',content:'这是一段用于验收的模拟对话。'}]}})
   }
   if(url.pathname==='/api/chat-sessions/forbidden')return route.fulfill({status:403,json:{detail:'Project scope denied'}})
   if(url.pathname==='/api/chat-sessions/missing')return route.fulfill({status:404,json:{detail:'Chat session not found'}})
   if(url.pathname==='/api/assistant/list')return route.fulfill({json:{assistants:['chat_session','digital_person'].map(name=>({name,configured:{engine:'pydantic_ai'},available_engines:[{id:'pydantic_ai',name:'Pydantic AI',installed:true,enabled:true,configured:true}]}))}})
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{providers:[],buttons:[],runs:[],active_action_ids:[],sessions:[]}})
   if(url.pathname==='/'||(workbench&&url.pathname==='/chat'))return route.fulfill({body:html,contentType:'text/html'})
   const filename=path.resolve(out,decodeURIComponent(url.pathname).replace(/^\//,''))
   if(!filename.startsWith(out+path.sep))return route.abort()
   try{return route.fulfill({body:await fs.readFile(filename),contentType:{'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'}[path.extname(filename)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
  })
  await page.addInitScript(()=>{
   window.conversationAnimations=[]
   const animate=Element.prototype.animate
   Element.prototype.animate=function(frames,options){
    if(this.parentElement?.matches('.digital-person-conversation-layer'))window.conversationAnimations.push(frames)
    return animate.call(this,frames,options)
   }
   Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360
    const context=canvas.getContext('2d');context.fillStyle='#487c8c';context.fillRect(0,0,640,360)
    return canvas.captureStream(5)
   }})
  })
  await page.goto(workbench?'https://home.invalid/chat?workbench':'https://home.invalid/')
  if(workbench){
   const submit=async(id,session_id)=>{
    const input=page.locator('.chat-workspace-pane textarea').first()
    await input.fill('打开 GitHub 会话')
    const accepted=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/chat-sessions/main/chat')
    await Promise.all([accepted,page.locator('.chat-workspace-pane .chat-input-send').first().click()])
      .catch(async error=>{throw new Error(`${error.message}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`)})
    await page.locator('[data-message-id="'+id+'"]').waitFor({state:'attached'})
    await page.evaluate(({id,session_id})=>window.finishWorkbenchTurn(id,{action:'conversation.open',project_id:'p',session_id}),{id,session_id})
   }
   await page.getByText('数字中枢对话',{exact:true}).first().waitFor({state:'attached'})
   const workspace=page.locator('[data-workbench-route]')
   const initialRoute=await workspace.getAttribute('data-workbench-route')
   assert.equal(await page.getByRole('dialog',{name:'发布复盘'}).count(),0)
   assert.equal(conversationRequests.filter(project=>project==='p').length,0,'history must not replay the old action')
   await submit('reply-1','preview')
   const dialog=page.getByRole('dialog',{name:'发布复盘'})
   await dialog.getByText('这是一段用于验收的模拟对话。').waitFor({timeout:5000})
   assert.equal(conversationRequests.filter(project=>project==='p').length,1)
   assert.equal(await workspace.getAttribute('data-workbench-route'),initialRoute)
   assert.doesNotMatch(await workspace.innerText(),/workstep-ui/)
   await page.screenshot({path:path.join(artifacts,'workbench-'+width+'-'+height+'.png')})
   await dialog.getByRole('button',{name:'关闭',exact:true}).click()
   await dialog.waitFor({state:'detached'})
   await submit('reply-2','forbidden')
   await page.getByText('你没有权限查看这段对话。',{exact:true}).waitFor()
   assert.equal(await dialog.count(),0)
   assert.deepEqual(errors,[])
   results.push({width,height,workbench:true})
   await page.close()
   continue
  }
  assert.equal(await page.locator('.digital-affect').count(),0)
  await page.locator('.digital-home').waitFor({timeout:5000}).catch(error=>{
   if(errors.length)throw new Error(errors.join('\n'))
   throw error
  })
  if(avatarMotionOnly){
   const presence=page.locator('.digital-presence-particles')
   await presence.locator('xpath=self::*[@data-frame]').waitFor()
   const checkMotion=async(label)=>{
    await page.waitForTimeout(200)
    const frame=await presence.getAttribute('data-frame')
    if(width>1023)await page.waitForFunction(frame=>document.querySelector('.digital-presence-particles')?.dataset.frame!==frame,frame,{timeout:5000})
    else{await page.waitForTimeout(180);assert.equal(await presence.getAttribute('data-frame'),frame,label)}
   }
   await page.locator('.digital-home-dock-transcript').click()
   await page.locator('.home-fixture-transcript').waitFor()
   await checkMotion('mobile transcript keeps the hidden avatar paused')
   await page.screenshot({path:path.join(artifacts,`avatar-transcript-${width}-${height}.png`)})
   await page.locator('.digital-home-chat header').getByRole('button',{name:'关闭',exact:true}).click()
   if(width>1023){
    await page.locator('.digital-home-work-summary').first().click()
    const delegation=page.getByRole('dialog',{name:'构建检查'})
    await delegation.getByText('模拟委派执行记录。',{exact:true}).waitFor()
    await checkMotion('visible desktop avatar keeps animating in delegated history')
    await page.screenshot({path:path.join(artifacts,`avatar-delegation-${width}-${height}.png`)})
    await delegation.locator('header').getByRole('button',{name:'关闭',exact:true}).click()
   }
   await page.evaluate(()=>window.homeFixture.uiAction('motion-open',{action:'conversation.open',project_id:'p',session_id:'preview'}))
   const conversation=page.getByRole('dialog',{name:'发布复盘'})
   await conversation.getByText('这是一段用于验收的模拟对话。').waitFor()
   await checkMotion('mobile conversation keeps the covered avatar paused')
   await page.screenshot({path:path.join(artifacts,`avatar-conversation-${width}-${height}.png`)})
   assert.deepEqual(errors,[])
   results.push({width,height,desktopAvatarAnimated:width>1023,mobileAvatarPaused:width<=1023});await page.close();continue
  }
  const dock=await page.locator('.digital-home-voice-dock').boundingBox()
  const dockButtons=page.locator('.digital-home-voice-dock > button, .digital-home-voice-dock [data-camera-toggle]')
  const buttonBoxes=await dockButtons.evaluateAll(buttons=>buttons.map(button=>{
   const box=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect()
   return {x:box.x,y:box.y,width:box.width,height:box.height,iconWidth:icon.width,iconHeight:icon.height,
    reachable:button.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))}
  }))
  assert.equal(buttonBoxes.length,5)
  assert.equal(await page.locator('.digital-home-keyboard').count(),1)
  for(const [index,box]of buttonBoxes.entries()){
   assert.ok(box.width>=44&&box.height>=44&&box.iconWidth===24&&box.iconHeight===24,`${width}: touch target and icon keep their sizes`)
   assert.ok(box.reachable,`${width}: button ${index} is reachable`)
   assert.ok(box.x>=dock.x&&box.x+box.width<=dock.x+dock.width&&box.y>=0&&box.y+box.height<=height,`${width}: button ${index} fits`)
   if(index){
    const gap=box.x-buttonBoxes[index-1].x-buttonBoxes[index-1].width
    assert.ok(width<=1023?gap>=8:Math.abs(gap-24)<1,`${width}: original button spacing is restored`)
    if(index>1)assert.ok(Math.abs(gap-(buttonBoxes[1].x-buttonBoxes[0].x-buttonBoxes[0].width))<1,`${width}: buttons remain evenly distributed`)
   }
  }
  if(width<=1023){
   const footerWidth=await page.locator('.digital-home-footer').evaluate(el=>el.clientWidth-parseFloat(getComputedStyle(el).paddingLeft)-parseFloat(getComputedStyle(el).paddingRight))
   assert.ok(Math.abs(dock.width-Math.min(footerWidth,360))<1,`${width}: mobile dock spans the original available width`)
  }
  assert.ok(Math.abs(height-dock.y-dock.height-(width<=1023?28:32))<1,`${width}: dock bottom distance is halved`)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  const clipAudit=await fs.readFile(path.resolve(root,'../../.agents/skills/desktop-agent-ui/scripts/clip-audit.js'),'utf8')
  const footerClip=await page.evaluate(`(${clipAudit})({root:'.digital-home-footer',viewport:true})`)
  assert.equal(footerClip.cut,0,`${width}: footer shadows remain inside the viewport`)
  await page.screenshot({path:path.join(artifacts,`home-five-buttons-${width}-${height}.png`)})
  if(width===390){
   const cdp=await page.context().newCDPSession(page)
   await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{bottom:34}})
   const safeDock=await page.locator('.digital-home-voice-dock').boundingBox()
   assert.ok(Math.abs(height-safeDock.y-safeDock.height-41)<1,'82px baseline with a 34px safe area is halved to 41px')
   await page.screenshot({path:path.join(artifacts,'home-five-buttons-safe-area-390.png')})
   await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{bottom:80}})
   const largeSafeDock=await page.locator('.digital-home-voice-dock').boundingBox()
   assert.ok(height-largeSafeDock.y-largeSafeDock.height>=80,'large system gesture areas remain fully protected')
   await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{bottom:0}})
   await cdp.detach()
  }
  const target=byId?{project_id:'p',session_id:'preview'}:{project:'视频功能项目',title:'发布复盘'}
  await page.evaluate(target=>window.homeFixture.uiAction('fixture-open',{action:'conversation.open',...target}),target)
  const conversation=page.getByRole('dialog',{name:'发布复盘'})
  await conversation.getByText('这是一段用于验收的模拟对话。').waitFor({timeout:10000}).catch(async error=>{
   throw new Error(`${error.message}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`)
  })
  await conversation.evaluate(async el=>{await Promise.all(el.getAnimations().map(a=>a.finished))})
  assert.equal(await page.locator('.digital-home-caption-frame').count(),0,'covered transcript must not keep a second message tree mounted')
  const presence=page.locator('.digital-presence-particles')
  await page.waitForTimeout(100)
  const pausedFrame=await presence.getAttribute('data-frame')
  await page.waitForTimeout(150)
  if(width<=1023)assert.equal(await presence.getAttribute('data-frame'),pausedFrame,'mobile conversation pauses the covered background canvas')
  else await page.waitForFunction(previous=>document.querySelector('.digital-presence-particles')?.dataset.frame!==previous,pausedFrame)
  if(byId)assert.deepEqual(conversationRequests,['p'],'opening by ID uses only the authorized first page')
  const panelBox=await conversation.boundingBox()
  assert.ok(panelBox.x>=0&&panelBox.y>=0&&panelBox.x+panelBox.width<=width&&panelBox.y+panelBox.height<=dock.y+1)
  assert.equal(await page.locator('.digital-home-microphone').evaluate(el=>{
   const box=el.getBoundingClientRect()
   return el.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))
  }),true,'microphone stays reachable while the conversation is open')
  await page.screenshot({path:path.join(artifacts,`home-conversation-${width}-${height}.png`)})
  await page.evaluate(()=>window.homeFixture.uiAction('fixture-close',{action:'window.close'}))
  await page.locator('.digital-person-conversation-layer').waitFor({state:'detached'})
  await page.locator('.digital-home-caption-frame').waitFor()
  await page.waitForFunction(previous=>document.querySelector('.digital-presence-particles')?.dataset.frame!==previous,pausedFrame)
  const animations=await page.evaluate(()=>window.conversationAnimations)
  assert.equal(animations.length,2)
  assert.match(animations[0][0].transform,/translate\(.+\) scale\(\.18\)/)
  assert.equal(animations[0][1].transform,'none')
  assert.equal(animations[1][0].transform,'none')
  assert.match(animations[1][1].transform,/scale\(\.18\)/)
  if(width===390){
   await page.emulateMedia({reducedMotion:'reduce'})
   await page.evaluate(()=>window.homeFixture.uiAction('reduced-open',{action:'conversation.open',project:'视频功能项目',title:'发布复盘'}))
   await conversation.waitFor()
   await page.evaluate(()=>window.homeFixture.uiAction('reduced-close',{action:'window.close'}))
   await page.locator('.digital-person-conversation-layer').waitFor({state:'detached'})
   assert.equal(await page.evaluate(()=>window.conversationAnimations.length),2)
   await page.emulateMedia({reducedMotion:'no-preference'})
  }
  if(byId&&(width===390||width===1440)){
   const statuses=[['forbidden','你没有权限查看这段对话。'],['missing','未找到指定对话，请核对项目和会话 ID。']]
   for(const [id,message]of statuses){
    await page.evaluate(id=>window.homeFixture.uiAction(id,{action:'conversation.open',project_id:'p',session_id:id}),id)
    await page.getByText(message,{exact:true}).waitFor()
    assert.equal(await page.locator('.digital-person-conversation-layer').count(),0)
   }
   await page.screenshot({path:path.join(artifacts,'home-conversation-missing-'+width+'.png')})
  }
  if(conversationOnly){
   await page.locator('.digital-home-keyboard').click()
   const composer=page.locator('.digital-home-composer-dialog')
   await composer.locator('textarea').fill('检查数字中枢输入是否顺畅')
   assert.equal(await page.locator('.digital-home-keyboard').getAttribute('aria-expanded'),'true')
   const inputBox=await composer.boundingBox()
   assert.ok(inputBox.x>=0&&inputBox.y>=0&&inputBox.x+inputBox.width<=width&&inputBox.y+inputBox.height<=height)
   await page.waitForTimeout(100)
   const frame=await presence.getAttribute('data-frame')
   await page.evaluate(()=>window.homeFixture.speaking(true,.7))
   await page.waitForTimeout(150)
   if(width<=1023)assert.equal(await presence.getAttribute('data-frame'),frame,'typing pauses the background canvas')
   await page.screenshot({path:path.join(artifacts,`home-keyboard-${width}-${height}.png`)})
   await page.evaluate(()=>window.homeFixture.speaking(false))
   await composer.getByRole('button',{name:'关闭',exact:true}).click()
   assert.equal(await page.locator('.digital-home-keyboard').getAttribute('aria-expanded'),'false')
   assert.equal(await page.locator('.digital-home-keyboard').evaluate(el=>el===document.activeElement),true)
   await page.waitForFunction(()=>document.querySelector('.digital-presence-particles')?.dataset.motion==='animated')
  }
  if(conversationOnly){
   assert.deepEqual(errors,[])
   results.push({width,height,conversation:true,microphoneReachable:true})
   await page.close()
   continue
  }
  const avatar=page.locator('.digital-home-avatar canvas')
  await page.locator('.digital-home-avatar canvas[data-avatar-pose]').waitFor()
  const frame=await avatar.getAttribute('data-frame')
  await page.waitForFunction(previous=>document.querySelector('canvas')?.dataset.frame!==previous,frame)
  assert.equal(await page.evaluate(()=>window.homeFixture.log.captures),0)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  assert.ok(dock.y>=0&&dock.y+dock.height<=height,`${width}: voice controls inside viewport`)
  await page.screenshot({path:path.join(artifacts,`home-idle-${width}-${height}.png`)})
  const controls=await page.locator('.digital-home-settings, .digital-home-voice-dock > button:not(.digital-home-keyboard)').evaluateAll(buttons=>buttons.map(button=>{
   const box=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect()
   return {name:button.className,dx:Math.abs(box.x+box.width/2-icon.x-icon.width/2),dy:Math.abs(box.y+box.height/2-icon.y-icon.height/2)}
  }))
  for(const control of controls)assert.ok(control.dx<=1&&control.dy<=1,`${width}: centered icon ${JSON.stringify(control)}`)
  const mediaButtons=page.locator('.digital-home-voice-dock > button, .digital-home-voice-dock [data-camera-toggle]')
  const sizes=await mediaButtons.evaluateAll(buttons=>buttons.map(button=>{
   const box=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect()
   const style=getComputedStyle(button)
   return {width:box.width,height:box.height,iconWidth:icon.width,iconHeight:icon.height,radius:style.borderRadius,border:style.borderWidth}
  }))
  assert.equal(sizes.length,5)
  for(const size of sizes)assert.deepEqual(size,sizes[0],`${width}: five dock buttons and icons have equal sizes`)
  if(width<=1023){
   assert.equal(await page.locator('[data-camera-toggle]').evaluate(el=>getComputedStyle(el).backgroundColor),await page.locator('.digital-home-speaker').evaluate(el=>getComputedStyle(el).backgroundColor))
   const back=await page.locator('.digital-home-back').boundingBox(),settings=await page.locator('.digital-home-settings').boundingBox()
   assert.equal(back.height,settings.height,`${width}: header controls use the same height`)
   const buttons=await page.locator('.digital-home-voice-dock > button:visible, .digital-home-voice-dock [data-camera-toggle]').all()
   const boxes=await Promise.all(buttons.map(button=>button.boundingBox()))
   const ordered=boxes.sort((a,b)=>a.x-b.x)
   assert.equal(ordered.length,5)
   for(let i=0;i<ordered.length;i++){
    assert.ok(ordered[i].x>=dock.x&&ordered[i].x+ordered[i].width<=dock.x+dock.width,`${width}: controls fit dock`)
    if(i)assert.ok(ordered[i].x>=ordered[i-1].x+ordered[i-1].width+3,`${width}: controls do not overlap`)
   }
   const stage=await page.locator('.digital-home-stage').boundingBox(),subtitles=await page.locator('.digital-home-subtitles').boundingBox(),footer=await page.locator('.digital-home-footer').boundingBox()
   assert.ok(stage.y+stage.height<=subtitles.y+1&&subtitles.y+subtitles.height<=footer.y+1,`${width}x${height}: avatar, long reply and footer do not overlap`)
   assert.ok(stage.height>100,`${width}x${height}: long reply leaves room for avatar`)
  }
  await page.locator('.digital-home-voice-dock [data-camera-toggle]').click()
  await page.waitForFunction(()=>document.querySelector('[data-camera-phase]')?.getAttribute('data-camera-phase')==='on')
  const selected=await page.locator('.digital-home-voice-dock [data-camera-toggle]').evaluate(button=>{
   const box=button.getBoundingClientRect(),style=getComputedStyle(button)
   return {width:box.width,height:box.height,radius:style.borderRadius,border:style.borderWidth,background:style.backgroundColor}
  })
  assert.equal(selected.width,sizes[0].width);assert.equal(selected.height,sizes[0].height)
  assert.equal(selected.radius,'50%');assert.equal(selected.border,'0px')
  assert.notEqual(selected.background,'rgb(255, 255, 255)')
  await page.screenshot({path:path.join(artifacts,`home-camera-selected-${width}-${height}.png`)})
  await page.locator('.digital-home-voice-dock [data-camera-toggle]').click()
  if(width<=1023){
   const identity=await page.locator('.digital-home-identity').boundingBox(),header=await page.locator('.digital-home-header').boundingBox()
   const aligned=await page.locator('.digital-home-back,.digital-home-identity,.digital-home-settings').evaluateAll(elements=>elements.map(element=>{const box=element.getBoundingClientRect();return box.y+box.height/2}))
   for(const center of aligned)assert.ok(Math.abs(center-aligned[0])<=1,`${width}: header controls align vertically`)
   const identityParts=await page.locator('.digital-home-identity > strong,.digital-home-identity > span').evaluateAll(elements=>elements.map(element=>{const box=element.getBoundingClientRect();return box.y+box.height/2}))
   assert.ok(Math.abs(identityParts[0]-identityParts[1])<=1,`${width}: name and state share a row`)
   const contentLeft=await page.locator('.digital-home-main').evaluate(element=>element.getBoundingClientRect().x+parseFloat(getComputedStyle(element).paddingLeft))
   const messageLeft=await page.locator('.digital-home-subtitles').evaluate(element=>element.getBoundingClientRect().x+parseFloat(getComputedStyle(element).paddingLeft))
   assert.ok(Math.abs(messageLeft-contentLeft)<=1,`${width}: captions align with content`)
   if(width<=400)assert.ok(Math.abs(dock.x+dock.width/2-width/2)<=1,`${width}: compact phone dock stays centered`)

   assert.ok(identity.x>width/2&&identity.y>=header.y&&identity.y+identity.height<=header.y+header.height,`${width}: compact identity at top right`)
   const stageBox=await page.locator('.digital-home-stage').boundingBox(),historyBox=await page.locator('.digital-home-subtitles').boundingBox()
   assert.ok(stageBox.height<=height*.37&&historyBox.height>=height*.22,`${width}: more room for history than avatar`)
  }
  await page.evaluate(()=>window.homeFixture.setHistory(Array.from({length:16},(_,index)=>({id:`history-${index}`,role:index%2?'assistant':'user',content:`第 ${index+1} 条历史。`+'这是一段可以上下拖动查看的完整历史消息。'.repeat(4),status:'succeeded'}))))
  const captions=page.locator('.digital-home-subtitles')
  await page.waitForFunction(()=>{const node=document.querySelector('.digital-home-subtitles');return node.scrollHeight>node.clientHeight+100})
  assert.notEqual(await page.locator('.digital-home-caption-frame').evaluate(el=>getComputedStyle(el,'::before').backgroundImage),'none')
  await captions.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'))})
  await page.evaluate(()=>window.homeFixture.setHistory(messages=>[...messages,{id:'new-history',role:'assistant',content:'新到达的消息不打断历史阅读。',status:'succeeded'}]))
  await page.waitForFunction(()=>document.querySelector('.digital-home-subtitles').textContent.includes('新到达'))
  assert.equal(await captions.evaluate(el=>el.scrollTop),0)
  await page.screenshot({path:path.join(artifacts,`home-scrolling-history-${width}-${height}.png`)})
  await page.evaluate(()=>window.homeFixture.setHistory([
   {id:'image-user',role:'user',content:'看看这张图片。\n\n![历史图片](.workstep/uploads/companion-test.webp)',status:'succeeded'},
   {id:'image-reply',role:'assistant',content:'**图片已保留**，回复文字采用普通字重。',status:'succeeded'},
  ]))
  const historyImage=page.locator('.digital-home-subtitles img')
  await historyImage.waitFor()
  await page.waitForFunction(()=>document.querySelector('.digital-home-subtitles img')?.naturalWidth>0)
  await captions.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'))})
  await page.screenshot({path:path.join(artifacts,`home-image-history-${width}-${height}.png`)})
  await historyImage.click()
  await page.locator('.image-preview').waitFor()
  await page.screenshot({path:path.join(artifacts,`home-image-preview-${width}-${height}.png`)})
  await page.locator('.image-preview').getByRole('button',{name:'关闭',exact:true}).click()
  await page.evaluate(()=>window.homeFixture.resetHistory())
  // Freeze body motion so pixel differences measure the mouth light itself.
  await page.emulateMedia({reducedMotion:'reduce'})
  const mouthBrightness=()=>page.evaluate(async()=>{
   for(let i=0;i<24;i++)await new Promise(requestAnimationFrame)
   const source=document.querySelector('.digital-home-avatar canvas'),copy=document.createElement('canvas')
   copy.width=source.width;copy.height=source.height
   const context=copy.getContext('2d');context.drawImage(source,0,0)
   const side=Math.min(source.width,source.height),x=source.width/2+.006*1.1*side,y=source.height/2-.030*1.1*side
   const pixels=context.getImageData(Math.round(x-.06*side),Math.round(y-.02*side),Math.round(.12*side),Math.round(.04*side)).data
   let total=0;for(let i=0;i<pixels.length;i+=4)total+=pixels[i]+pixels[i+1]+pixels[i+2]
   return total/(pixels.length/4*3)
  })
  const idleMouth=await mouthBrightness()
  await page.evaluate(()=>window.homeFixture.speaking(true,.9))
  const litMouth=await mouthBrightness()
  assert.ok(litMouth>idleMouth+2,`${width}: speaking mouth visibly lights up (${idleMouth} -> ${litMouth})`)
  await page.screenshot({path:path.join(artifacts,`home-mouth-lit-${width}-${height}.png`)})
  await page.evaluate(()=>window.homeFixture.speaking(false,0))
  assert.ok(Math.abs(await mouthBrightness()-idleMouth)<1,`${width}: mouth light resets after playback`)
  await page.emulateMedia({reducedMotion:'no-preference'})
  if(width===390){
   await page.waitForFunction(()=>Number(document.querySelector('.digital-home-avatar canvas')?.dataset.blink)>.85,{},{timeout:12000})
   await page.screenshot({path:path.join(artifacts,`home-blink-${width}.png`)})
   await page.waitForFunction(()=>Number(document.querySelector('.digital-home-avatar canvas')?.dataset.blink)===0)
  }
  // An actual user gesture starts the shared capture hook; fixture supplies PCM,
  // ASR text and one synthetic response, then real WebAudio schedules PCM output.
  await page.locator('.digital-home-microphone').click()
  await page.waitForFunction(()=>window.homeFixture.log.captures===1)
  await page.evaluate(()=>{window.homeFixture.sound(.12);window.homeFixture.silence()})
  await page.locator('.digital-home-end[data-action=send]').click()
  await page.waitForFunction(()=>window.homeFixture.log.sent.length===1,{},{timeout:6000})
  await page.waitForFunction(()=>window.homeFixture.log.audio>0,{},{timeout:6000})
  await page.waitForFunction(()=>window.homeFixture.log.playbackFrames>0,{},{timeout:6000})
  await page.waitForFunction(()=>window.homeFixture.log.captures>=2)
  assert.deepEqual(await page.evaluate(()=>window.homeFixture.log.sent),['帮我看看今天的安排。'])
  assert.equal(await page.evaluate(()=>window.homeFixture.log.stops),0,'voice never auto-stops the running engine')
  await page.evaluate(()=>window.homeFixture.speaking(true,.7))
  await page.waitForFunction(()=>document.querySelector('.digital-home')?.getAttribute('data-state')==='speaking')
  await page.waitForFunction(()=>!document.querySelector('.digital-home-microphone')?.getAttribute('aria-busy'))
  const painted=await avatar.evaluate(c=>{const gl=c.getContext('webgl');const pixels=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let opaque=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>32)opaque++;return {size:[c.width,c.height],opaque,lost:gl.isContextLost()}})
  assert.ok(!painted.lost&&painted.opaque>1000,`${width}: avatar remains rendered during speech ${JSON.stringify(painted)}`)
  await page.screenshot({path:path.join(artifacts,`home-speaking-${width}-${height}.png`)})
  await page.evaluate(()=>window.homeFixture.speaking(false,0))
  await page.locator('.digital-home-keyboard').click()
  await page.locator('.digital-home-composer textarea').waitFor()
  assert.equal(await page.locator('.digital-home-microphone').count(),1)
  assert.equal(await page.locator('.digital-home-stage').isVisible(),true)
  assert.equal(await page.locator('.digital-home-voice-hint').count(),0)
  const audioBefore=await page.evaluate(()=>window.homeFixture.log.audio)
  await page.locator('.digital-home-composer textarea').fill('文字输入也要播报')
  await page.locator('.digital-home-composer .chat-input-send[data-state=active]').click()
  await page.waitForFunction(()=>window.homeFixture.log.sent.includes('文字输入也要播报'))
  await page.waitForFunction(before=>window.homeFixture.log.audio>before,audioBefore)
  const composerBox=await page.locator('.digital-home-composer').boundingBox()
  assert.ok(composerBox.x>=0&&composerBox.x+composerBox.width<=width&&composerBox.y>=0&&composerBox.y+composerBox.height<=height)
  await page.screenshot({path:path.join(artifacts,`home-text-${width}-${height}.png`)})
  await page.locator('.digital-home-keyboard').click()
  await page.locator('.digital-home-microphone').waitFor()
  const captures=await page.evaluate(()=>window.homeFixture.log.captures)
  await page.locator('.digital-home-end').click()
  await page.waitForFunction(()=>document.querySelector('.digital-home-microphone')?.getAttribute('aria-pressed')==='false')
  assert.equal(await page.evaluate(()=>window.homeFixture.log.captures),captures)
  const audioAtHistory=await page.evaluate(()=>window.homeFixture.log.audio)
  await page.locator('.digital-home-dock-transcript').click()
  await page.locator('.digital-home-chat .home-fixture-transcript').waitFor()
  assert.equal(await page.evaluate(()=>window.homeFixture.log.audio),audioAtHistory)
  await page.screenshot({path:path.join(artifacts,`home-history-${width}-${height}.png`)})
  await page.getByRole('button',{name:'关闭',exact:true}).click()
  assert.deepEqual(errors,[])
  results.push({width,height,bones:11,animation:true,mouthLight:true,voiceTurn:true,scheduledSpeech:true,textView:true,overflow:false,errors})
  await page.close()
 }
}finally{await browser.close()}
await fs.writeFile(path.join(artifacts,avatarMotionOnly?'avatar-motion-results.json':conversationOnly?'conversation-results.json':'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
