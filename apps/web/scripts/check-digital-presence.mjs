import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.resolve(process.env.WORKSTEP_PRESENCE_ARTIFACTS ?? path.join(root,'../../tmp/digital-presence-implementation')),out=path.join(artifacts,'browser')
await fs.mkdir(artifacts,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.join(root,'tests/fixtures/digital-person-home/index.html')}}})
const html=await fs.readFile(path.join(out,'tests/fixtures/digital-person-home/index.html'))
const clipAudit=(0,eval)(await fs.readFile(path.resolve(root,'../../.agents/skills/desktop-agent-ui/scripts/clip-audit.js'),'utf8'))
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']})
const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[],results=[]
page.on('pageerror',e=>errors.push(e.message))
try{
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.hostname!=='presence.invalid')return route.abort()
  if(url.pathname.startsWith('/api/')){
   if(url.pathname.endsWith('/memory/atlas'))return route.fulfill({json:{items:[],links:[]}})
   if(url.pathname.endsWith('/activity/records')){
    const runOffset=Number(url.searchParams.get('run_offset')||0),taskOffset=Number(url.searchParams.get('delegation_offset')||0),limit=Number(url.searchParams.get('limit')||5)
    const runs=Array.from({length:12},(_,i)=>({id:`r${i+1}`,status:i===0?'failed':'silent',outcome:i===0?null:i===1?{sent:1,failed:0,affinity_increased:2,affinity_decreased:0,message_preview:'早上好，昨天说的入口我记住了。'}:{sent:0,failed:0,affinity_increased:0,affinity_decreased:0},summary:i===0?'本轮思考未完成':i===1?'整理 100 条消息（10 个会话），新增 18 条记忆':'尚未领取本轮待整理消息，保留待处理状态',created_at:`2026-11-17T${String(10-Math.floor(i/6)).padStart(2,'0')}:${String(54-i*3%60).padStart(2,'0')}:00Z`}))
    const delegations=Array.from({length:12},(_,i)=>({id:`work${i}`,project_id:'p',session_id:'s',instruction:i===0?'修复 WorkStep 视频摄像头功能，用户当前点击打开摄像头后界面显示发送消息时附上当前画面':'整理项目工作安排',status:['completed','running','failed','unavailable','completed'][i]??'completed',message_id:i===0?'fixture-reply':null,result_viewed:i===0?false:i===2||i>=4?true:null,notification_state:i===0?'notified':'pending',created_at:`2026-11-${i<4?17:16}T10:${42-i}:00Z`}))
    return route.fulfill({json:{reflection_count:237,run_total:100,delegation_total:12,checking:false,delegations:delegations.slice(taskOffset,taskOffset+limit),runs:runs.slice(runOffset,runOffset+limit)}})
   }
   if(url.pathname.includes('/digital-person/runs/'))return route.fulfill({json:{id:'fixture',status:'failed',draft_summary:'我想跟进昨天的安排。\n'+('这轮交流让我记住了新的入口位置。'.repeat(18)),failure_reason:'未能确认思考内容对应的消息，本轮结果未采用。',outcome:{sent:0,failed:0,affinity_increased:0,affinity_decreased:0},error:'Invalid sources in the check result',created_at:'2026-11-17T10:54:00Z'}})
   if(url.pathname.endsWith('/faces/catalog'))return route.fulfill({json:{revision:'fixture',settings:{enabled:false,include_people:false,show_names:false},people:[]}})
   if(url.pathname.endsWith('/affect'))return route.fulfill({json:{state:{person_id:'p',name:'会话作者',affinity:68,emotion:'calm',valence:0,arousal:0,updated_at:null,history:[]}}})
   if(url.pathname.endsWith('/chat-sessions/s'))return route.fulfill({json:{id:'s',project_id:'p',title:'修复 WorkStep 视频摄像头功能',engine:'pydantic_ai',running:false,messages:[{id:'fixture-reply',role:'assistant',status:'succeeded',content:'已验证视频摄像头功能。'}]}})
   if(url.pathname.endsWith('/assistants'))return route.fulfill({json:{assistants:[{name:'chat_session',configured:{},available_engines:[]}]}})
   return route.fulfill({json:{providers:[],buttons:[],runs:[],active_action_ids:[],sessions:[]}})
  }
  if(url.pathname==='/')return route.fulfill({body:html,contentType:'text/html'})
  const file=path.resolve(out,decodeURIComponent(url.pathname).replace(/^\//,''));if(!file.startsWith(out+path.sep))return route.abort()
  try{return route.fulfill({body:await fs.readFile(file),contentType:{'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'}[path.extname(file)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
 })
 for(const [width,height]of [[320,640],[390,844],[390,480],[844,390],[1023,800],[1024,800],[1440,1024]]){
  await page.setViewportSize({width,height});await page.goto('https://presence.invalid/')
  const screenshotSize=width===390&&height===480?'390x480':width
  const stage=page.locator('.digital-home-stage'),captions=page.locator('.digital-home-caption-frame'),keyboard=page.locator('.digital-home-keyboard')
  await keyboard.waitFor()
  const phone=page.locator('.digital-home-end')
  const phoneBackground=()=>phone.evaluate(async el=>{
   void getComputedStyle(el).backgroundColor
   await Promise.all(el.getAnimations().map(animation=>animation.finished))
   return getComputedStyle(el).backgroundColor
  })
  const idlePhoneBackground=await phoneBackground()
  const {width:phoneWidth,height:phoneHeight}=await phone.boundingBox()
  await phone.click()
  await phone.and(page.locator('[data-action=hangup]:enabled')).waitFor()
  const hangupColor=(await phoneBackground()).match(/\d+/g)?.map(Number)
  assert.ok(hangupColor&&hangupColor[0]>hangupColor[1]+45&&hangupColor[0]>hangupColor[2]+45,`${width}: hang-up button has a red background`)
  const hangupBox=await phone.boundingBox()
  assert.equal(hangupBox.width,phoneWidth)
  assert.equal(hangupBox.height,phoneHeight)
  await page.screenshot({path:path.join(artifacts,`hangup-${screenshotSize}.png`)})
  await phone.click()
  await phone.and(page.locator('[data-action=phone]')).waitFor()
  await page.mouse.move(0,0)
  assert.equal(await phoneBackground(),idlePhoneBackground,'ending a call restores the idle color')
  const history=captions.locator('.digital-home-subtitles')
  const waitForBottom=()=>page.waitForFunction(()=>{
   const el=document.querySelector('.digital-home-subtitles')
   return el.scrollHeight>el.clientHeight&&Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<=1
  })
  await page.evaluate(()=>window.homeFixture.setHistory(Array.from({length:20},(_,i)=>({
   id:`history-${i}`,role:'user',content:`历史消息 ${i+1}`,
  }))))
  await waitForBottom()
  const appendMessage=text=>page.evaluate(content=>window.homeFixture.setHistory(rows=>[
   ...rows,{id:`history-${rows.length}`,role:'user',content},
  ]),text)
  await appendMessage('贴底时收到新消息')
  await history.getByText('贴底时收到新消息',{exact:true}).waitFor()
  await waitForBottom()
  await history.hover()
  await page.mouse.wheel(0,-20)
  await page.waitForFunction(()=>{
   const el=document.querySelector('.digital-home-subtitles')
   return el.scrollHeight-el.clientHeight-el.scrollTop>=15
  })
  const readingTop=await history.evaluate(el=>el.scrollTop)
  await appendMessage('翻阅历史时收到新消息')
  await history.getByText('翻阅历史时收到新消息',{exact:true}).waitFor()
  assert.equal(await history.evaluate(el=>el.scrollTop),readingTop,`${width}: new messages preserve the reading position`)
  await page.mouse.wheel(0,1500)
  await waitForBottom()
  await appendMessage('回到底部后收到新消息')
  const latest=history.getByText('回到底部后收到新消息',{exact:true})
  await latest.waitFor()
  await waitForBottom()
  await latest.evaluate(el=>{el.style.minHeight='90px'})
  await waitForBottom()
  if(width===390&&height===844){
   const touch=await context.newCDPSession(page)
   const {x,y,width:w,height:h}=await history.boundingBox()
   const point={x:x+w/2,y:y+h/2}
   await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]})
   await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...point,y:point.y+24}]})
   await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...point,y:point.y+48}]})
   await page.waitForFunction(()=>{
    const el=document.querySelector('.digital-home-subtitles')
    return el.scrollHeight-el.clientHeight-el.scrollTop>=15
   })
   const draggedTop=await history.evaluate(el=>el.scrollTop)
   await appendMessage('拖动历史时收到新消息')
   await history.getByText('拖动历史时收到新消息',{exact:true}).waitFor()
   assert.equal(await history.evaluate(el=>el.scrollTop),draggedTop,'new messages preserve the active touch position')
   await touch.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]})
   await touch.detach()
   await history.press('End')
   await waitForBottom()
  }
  await page.screenshot({path:path.join(artifacts,`history-follow-${screenshotSize}.png`)})
  await page.reload()
  await keyboard.waitFor()
  if(width<=1023){
   const landscape=height<=500&&width>=600
   const stageBox=await stage.boundingBox()
   assert.ok(Math.abs((landscape?stageBox.width:stageBox.height)-.45*(landscape?width:height))<1,
    `${width} × ${height}: avatar uses 45% of the viewport`)
   const history=captions.locator('.digital-home-subtitles')
   const historyBox=await history.boundingBox()
   assert.ok(historyBox.height>0 && (landscape || historyBox.width>=width-40), 'history has an independent reading area')
   assert.equal(await captions.locator('.digital-home-live-caption-slot').isHidden(),true,'idle voice transcription reserves no height')

   const atlas=page.getByRole('button',{name:'记忆星图',exact:true})
   await atlas.click()
   const sky=page.locator('.memory-atlas-sky')
   await sky.waitFor()
   const returnToHub=page.locator('.digital-home-presence-info').getByRole('button',{name:'数字中枢',exact:true})
   assert.equal(await returnToHub.isVisible(),true,'the atlas switch names the destination')
   assert.deepEqual(await returnToHub.evaluate(button=>{
    const style=getComputedStyle(button)
    const frame=getComputedStyle(button.firstElementChild,'::after')
    return [style.backgroundColor,style.webkitTapHighlightColor,frame.borderTopStyle,frame.borderTopWidth]
   }),['rgba(0, 0, 0, 0)','rgba(0, 0, 0, 0)','solid','1px'],'the switch keeps its border and transparent background')
   await stage.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)))
   if(!landscape){
    const {x,y,width:skyWidth,height:skyHeight}=await sky.boundingBox()
    assert.ok(Math.abs(x)<1&&Math.abs(skyWidth-width)<1,'the atlas sky meets both edges in the stacked mobile layout')
    assert.deepEqual([y,skyHeight],[stageBox.y,stageBox.height],'the full-width atlas keeps the avatar stage height')
    const zoomControls=page.locator('.atlas-camera button')
    await zoomControls.nth(1).focus()
    await zoomControls.nth(1).press('Enter')
    await zoomControls.nth(1).press('Enter')
    assert.deepEqual(await sky.boundingBox(),{x,y,width:skyWidth,height:skyHeight},'zoom preserves full-width sky coverage')
    await zoomControls.nth(2).press('Enter')
   }else{
    assert.deepEqual(await stage.boundingBox(),stageBox,'the atlas shares the avatar stage in compact layouts')
   }
   assert.deepEqual(await history.boundingBox(),historyBox,'switching the stage keeps the history dimensions')
   const hitAreas=await page.locator('.digital-home-presence-info').evaluate(info=>{
    const {left}=info.getBoundingClientRect()
    return [...info.querySelectorAll('button')].map(button=>{
     const box=button.getBoundingClientRect()
     const y=box.top+box.height/2
     return {
      label:button.textContent,
      touchSize:Math.min(box.width,box.height),
      receivesOwnTap:button.contains(document.elementFromPoint(box.left+box.width/2,y)),
      blocksStage:document.elementFromPoint(left+1,y)?.closest('.digital-home-presence-info')!==null,
     }
    })
   })
   for(const area of hitAreas){
    assert.ok(area.touchSize>=44&&area.receivesOwnTap,`${width}px: ${area.label} stays tappable`)
    if(height>500||width>=600)assert.equal(area.blocksStage,false,`${width}px: ${area.label} does not intercept taps in the empty strip`)
   }
   await page.screenshot({path:path.join(artifacts,`atlas-hit-targets-${screenshotSize}.png`)})
   await returnToHub.click()
   await page.locator('.memory-atlas-sky').waitFor({state:'detached'})
   assert.equal(await atlas.isVisible(),true,'returning to the hub restores the atlas label')
   await stage.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)))
  }
  if(width<=1023){
   const transcript=page.getByRole('button',{name:'展开对话',exact:true})
   const dock=page.locator('.digital-home-voice-dock')
   assert.equal(await dock.getByRole('button',{name:'展开对话',exact:true}).count(),0,'mobile transcript is outside the voice dock')
   const [group,chat,key]=await Promise.all([dock.boundingBox(),transcript.boundingBox(),keyboard.boundingBox()])
   const compactFooter=width<600&&height<=680
   assert.ok(chat.height>=44&&chat.width>=44,'transcript keeps its touch target')
   if(!compactFooter)assert.ok(Math.abs(chat.x+chat.width-(width-20))<2,'transcript sits at the right inset')
   assert.ok(chat.x>=key.x+key.width&&Math.abs(chat.y+chat.height/2-(key.y+key.height/2))<2,'transcript shares the keyboard row without overlap')
   if(compactFooter)assert.ok(group.x+group.width<=key.x&&Math.abs(group.y+group.height/2-(key.y+key.height/2))<2,'short portrait puts all controls on a single row')
   if(height>500&&!compactFooter){
    assert.ok(chat.y>=group.y+group.height,'portrait transcript is below the voice dock')
    assert.ok(Math.abs(key.x+key.width/2-width/2)<2,'portrait keyboard stays centered')
   }
  }
  const measure=()=>Promise.all([stage.boundingBox(),captions.boundingBox()])
  const before=await measure()
  await keyboard.click()
  const dialog=page.locator('.digital-home-composer-dialog'),input=dialog.locator('textarea')
  await input.waitFor()
  assert.equal(await input.evaluate(el=>el===document.activeElement),true)
  const [trigger,anchored]=await Promise.all([keyboard.boundingBox(),dialog.boundingBox()])
  const center=trigger.x+trigger.width/2
  const expectedLeft=Math.max(8,Math.min(center-anchored.width/2,width-anchored.width-8))
  assert.ok(Math.abs(anchored.x-expectedLeft)<2,`composer aligns with the keyboard trigger at ${width}px`)
  assert.ok(Math.abs(anchored.y+anchored.height-(trigger.y-8))<2,`composer opens 8px above the keyboard trigger at ${width}px`)
  if(width<=1023)await page.evaluate(()=>document.documentElement.style.setProperty('--app-viewport-height',`${innerHeight-210}px`))
  await input.fill('这是数字人首页的文字输入草稿。')
  assert.deepEqual(await measure(),before,`the composer leaves the stage and captions in place at ${width}px`)
  const box=await dialog.boundingBox(),inputBox=await input.boundingBox()
  assert.ok(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=height-(width<=1023?210:0)+1)
  assert.ok(inputBox.y+inputBox.height<=box.y+box.height)
  await dialog.locator('.chat-input-send').click({trial:true})
  if(width<=1023)await page.evaluate(()=>document.documentElement.style.removeProperty('--app-viewport-height'))
  await page.screenshot({path:path.join(artifacts,`keyboard-${screenshotSize}.png`)})
  if(width>=1024){
   const audit=await page.evaluate(clipAudit,{root:'.digital-home-composer-backdrop'});assert.equal(audit.cut,0,JSON.stringify(audit))
   assert.equal(await dialog.getByRole('separator').count(),8)
   const resize=dialog.locator('.resizable-panel-e');await resize.focus();await resize.press('ArrowRight')
   assert.ok((await dialog.boundingBox()).width>box.width,'desktop composer can resize')
  }else assert.equal(await dialog.getByRole('separator').count(),0)
  if(width===390){await page.goBack();await dialog.waitFor({state:'detached'})}
  else if(width===320){await page.mouse.click(150,20);await dialog.waitFor({state:'detached'})}
  else {await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'})}
  assert.equal(await keyboard.evaluate(el=>el===document.activeElement),true)
  await keyboard.click();assert.equal(await input.inputValue(),'这是数字人首页的文字输入草稿。')
  await dialog.locator('header button').click()
  if(width===390&&height===844){
   const history=captions.locator('.digital-home-subtitles')
   const idleHistoryHeight=(await history.boundingBox()).height
   const slot=captions.locator('.digital-home-live-caption-slot')
   await page.locator('.digital-home-microphone').click()
   await page.waitForFunction(()=>window.homeFixture.log.captures===1)
   await page.evaluate(()=>{window.homeFixture.sound(.12);window.homeFixture.silence()})
   const draft=slot.locator('.digital-home-live-caption-edit')
   await draft.waitFor()
   assert.match(await draft.innerText(),/今天的安排/)
   assert.ok((await history.boundingBox()).height<idleHistoryHeight,'voice transcription uses the space below history')
   await page.screenshot({path:path.join(artifacts,'mobile-voice-transcription.png')})
   await draft.click()
   const editor=slot.locator('textarea')
   await editor.fill('保留这段语音草稿。')
   assert.equal(await editor.inputValue(),'保留这段语音草稿。')
  }
 }
 for(const [name,width,height]of [['mobile',390,844],['narrow',320,640],['landscape',844,390],['compact-edge',1023,800],['desktop-edge',1024,800],['desktop',1440,1024],['wide',2560,1440]]){
  await page.setViewportSize({width,height});await page.goto('https://presence.invalid/');await page.locator('.digital-presence-particles[data-frame]').waitFor()
  assert.equal(await page.locator('.digital-home-identity').count(),1)
  const reflection=page.locator('.digital-home-presence-info').getByRole('button',{name:'主动思考',exact:true})
  assert.match(await reflection.innerText(),/237/)
  assert.match(await page.locator('.digital-home-presence-info').innerText(),/68/)
  await page.screenshot({path:path.join(artifacts,name+'-idle.png')})
  if(name!=='wide'&&name!=='landscape'){
   if(width<=1023){
    await page.locator('.digital-home-activity-entry').click()
    await page.locator('.digital-home-activity-dialog').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)))
   }
   const task=page.locator('.digital-home-work-summary').first()
   await task.getByText('未查看',{exact:true}).waitFor()
   const timeline=page.locator('[data-activity-scroll="delegations"]')
   assert.equal(await timeline.locator('.digital-home-work-day').count(),2)
   assert.doesNotMatch(await page.locator('.digital-home-context').innerText(),/主动思考/)
   assert.match(await timeline.innerText(),/执行中/)
   assert.match(await timeline.innerText(),/失败/)
   assert.match(await timeline.innerText(),/不可用/)
   const row=await task.evaluate(el=>{
    const title=el.querySelector('strong'),time=el.querySelector('time'),bounds=el.getBoundingClientRect(),icon=el.querySelector('svg').getBoundingClientRect()
    return {height:bounds.height,icon:icon.width,titleHeight:title.getBoundingClientRect().height,line:parseFloat(getComputedStyle(title).lineHeight),
     titleTop:title.getBoundingClientRect().top,timeTop:time.getBoundingClientRect().top,timeText:time.textContent,timeRight:time.getBoundingClientRect().right,right:bounds.right}
   })
   assert.ok(row.titleHeight<=row.line*2+1)
   assert.ok(Math.abs(row.titleTop-row.timeTop)<1)
   assert.match(row.timeText,/\d{2}:\d{2}/)
   assert.ok(row.timeRight<=row.right+1)
   assert.equal(row.icon,14)
   if(width<=1023)assert.ok(row.height>=44&&(await page.locator('.digital-home-activity-close').boundingBox()).height>=44)
   await page.screenshot({path:path.join(artifacts,name+'-delegation-timeline.png')})
   await task.click()
   const dialog=page.locator('.digital-person-delegation-dialog'),project=dialog.locator('.digital-person-delegation-project'),close=dialog.locator('.digital-person-delegation-close')
   await dialog.getByText('已验证视频摄像头功能。',{exact:true}).waitFor({timeout:6000}).catch(async error=>{throw new Error(`${await page.evaluate(()=>document.body.innerText)}\n${errors.join('\n')}`,{cause:error})})
   assert.equal(await project.innerText(),'视频功能项目')
   assert.equal(await dialog.locator('.assistant-chat-header').count(),0)
   const [heading,projectBox,button]=await Promise.all([dialog.locator('header h2').boundingBox(),project.boundingBox(),close.boundingBox()])
   const center=box=>box.y+box.height/2
   assert.ok(Math.abs(center(heading)-center(projectBox))<1&&Math.abs(center(projectBox)-center(button))<1,'delegation title, project and close share one row')
   assert.ok(heading.x+heading.width<=projectBox.x&&projectBox.x+projectBox.width<=button.x&&button.x+button.width<=width,'long title leaves room for the project and close button')
   if(name==='desktop')assert.equal((await page.evaluate(clipAudit,{root:'.digital-person-delegation-backdrop'})).cut,0)
   await page.screenshot({path:path.join(artifacts,name+'-delegation-project.png')})
   await close.click()
   await task.getByText('已查看',{exact:true}).waitFor()
   if(width<=1023)await page.locator('.digital-home-activity-close').click()
  }
  if(name==='desktop'||name==='narrow'){
   const transcript=page.locator('.digital-home-subtitles'),play=transcript.getByRole('button',{name:'朗读回复'}),stop=transcript.getByRole('button',{name:'停止朗读'})
   const actions=transcript.locator('.digital-home-reply-actions'),praise=actions.locator('.digital-person-feedback-button').first()
   await actions.hover()
   const [player,vote,frame]=await Promise.all([play.boundingBox(),praise.boundingBox(),transcript.boundingBox()])
   assert.ok(player.x>vote.x&&Math.abs(player.y-vote.y)<1&&player.height===vote.height,'read action is aligned beside feedback')
   assert.ok(player.x+player.width<=frame.x+frame.width&&player.y+player.height<=frame.y+frame.height,'read action fits in the subtitle viewport')
   await page.screenshot({path:path.join(artifacts,name+'-caption-actions.png')})
   await page.evaluate(()=>window.homeFixture.setTtsDelay(1200))
   await play.click();await stop.waitFor();await stop.click();await play.waitFor()
   await page.evaluate(()=>window.homeFixture.setTtsDelay(0))
   await play.click();await page.waitForFunction(()=>window.homeFixture.log.playbackFrames>0);await play.waitFor()
   await page.evaluate(()=>window.homeFixture.setHistory([{id:'waiting',role:'assistant',status:'running',content:'',created_at:new Date(Date.now()-5000).toISOString()}]))
   const thinking=transcript.locator('.digital-home-thinking');await thinking.waitFor()
   const elapsed=await thinking.locator('span').innerText();assert.match(elapsed,/\d+秒/)
   await page.waitForFunction(previous=>document.querySelector('.digital-home-thinking span')?.textContent!==previous,elapsed)
   await page.screenshot({path:path.join(artifacts,name+'-caption-elapsed.png')})
   await page.evaluate(()=>window.homeFixture.resetHistory())
  }
  await page.evaluate(()=>{window.settingsOpened=0;window.addEventListener('workstep:open-digital-person-settings',()=>window.settingsOpened++)})
  for(const [selector,kind]of [['.digital-home-identity','profile'],['.digital-home-affinity','affinity'],['.digital-home-metric:not(.digital-home-affinity)','reflection']]){
   await page.locator(selector).click();await page.locator('.digital-home-detail-panel').waitFor();assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');await page.screenshot({path:path.join(artifacts,name+'-detail-'+kind+'.png')});
   if(kind==='reflection'){
    const panel=page.locator('.digital-home-detail-panel--reflection')
    assert.ok(await panel.locator('footer .digital-home-detail-pages').isVisible())
    await panel.locator('.digital-home-detail-run .digital-run-detail-toggle').first().click()
    await panel.locator('.digital-person-run-detail p').first().waitFor()
    assert.match(await panel.locator('.digital-person-run-detail').innerText(),/好感度 0/)
    const footer=await panel.locator('footer').boundingBox(),content=await panel.locator('.digital-home-detail-content').boundingBox()
    assert.ok(content.y+content.height<=footer.y+1)
   }
   await page.locator('.digital-home-detail-close').click();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.settingsOpened),0)
  }

  const fits=await page.evaluate(()=>({width:document.documentElement.scrollWidth<=innerWidth,height:document.documentElement.scrollHeight<=innerHeight+1}));assert.deepEqual(fits,{width:true,height:true})
  if(name!=='landscape'){const stage=await page.locator('.digital-home-stage').boundingBox();assert.ok(Math.abs(stage.x+stage.width/2-width/2)<2,'orb stays centered')}
  const header=await page.locator('.digital-home-header').boundingBox(),back=await page.locator('.digital-home-back').boundingBox();assert.ok(width>1023?Math.abs(back.x+back.width-(width-32))<2:Math.abs(back.x-20)<2)
  assert.ok(header.height>0)
  if(width>1023){
   const layout=await page.evaluate(()=>{const context=document.querySelector('.digital-home-context'),identity=document.querySelector('.digital-home-presence-info'),scroll=document.querySelector('[data-activity-scroll="delegations"]'),bounds=scroll.getBoundingClientRect(),rows=[...scroll.querySelectorAll('.digital-home-work-summary')].map(row=>row.getBoundingClientRect());return {top:context.getBoundingClientRect().top,identityTop:identity.getBoundingClientRect().top,sidebarRight:context.getBoundingClientRect().right,captionLeft:document.querySelector('.digital-home-caption-frame').getBoundingClientRect().left,visibleTasks:rows.filter(row=>row.top>=bounds.top-1&&row.bottom<=bounds.bottom+1).length,listHeight:bounds.height,rowHeight:rows[0]?.height,scrollbars:[...document.querySelectorAll('.digital-home-activity-scroll')].map(el=>getComputedStyle(el).scrollbarWidth)}})
   assert.ok(Math.abs(layout.top-layout.identityTop)<1,'left and right share the top baseline')
   assert.ok(layout.sidebarRight<layout.captionLeft,'activity stays clear of the subtitles')
   assert.equal(layout.visibleTasks,5,`${name}: five full delegation rows are visible without scrolling (${JSON.stringify(layout)})`)
   assert.deepEqual(layout.scrollbars,['none'])
  }
  if(width>1440){const left=await page.locator('.digital-home-context').boundingBox(),right=await page.locator('.digital-home-presence-info').boundingBox();assert.ok(left.x>=(width-1440)/2+30);assert.ok(right.x+right.width<=width-(width-1440)/2-30)}
  await page.evaluate(()=>window.homeFixture.setActivity('think'));await page.waitForFunction(()=>document.querySelector('.digital-presence-particles')?.dataset.presencePhase==='thinking');await page.waitForTimeout(700);await page.screenshot({path:path.join(artifacts,name+'-thinking.png')})
  await page.evaluate(()=>window.homeFixture.speaking(true,.8));await page.waitForFunction(()=>Number(document.querySelector('.digital-presence-particles')?.dataset.level)>.5);await page.screenshot({path:path.join(artifacts,name+'-speaking.png')})
  await page.evaluate(()=>window.homeFixture.speaking(false,0));await page.evaluate(()=>window.homeFixture.setActivity('idle'))
  await page.evaluate(()=>window.keptOrb=document.querySelector('.digital-presence-particles'))
  const before=await page.locator('.digital-home-stage').boundingBox()
  if(width>1023){assert.equal(await page.locator('[data-recent-message]').count(),0,'chat messages are not repeated in the sidebar');assert.match(await page.locator('.digital-home-context').innerText(),/动态/);assert.doesNotMatch(await page.locator('.digital-home-context').innerText(),/主动思考/)}
  await page.locator('.digital-home-dock-transcript').click()
  if(width>1023){await page.waitForTimeout(140);const middle=await page.locator('.digital-home-stage').boundingBox();assert.ok(middle.width<before.width&&middle.width>220);await page.screenshot({path:path.join(artifacts,'desktop-chat-moving.png')})}
  await page.waitForTimeout(900);assert.equal(await page.locator('.digital-home-chat').isVisible(),true)
  assert.equal(await page.evaluate(()=>window.keptOrb===document.querySelector('.digital-presence-particles')),true)
  if(width>1023){
   const activity=page.locator('.digital-home-context')
   assert.equal(await activity.isVisible(),true,'expanded conversation retains the activity below the orb')
   const orb=await page.locator('.digital-home-stage').boundingBox(),sidebar=await activity.boundingBox(),chat=await page.locator('.digital-home-chat').boundingBox()
   assert.ok(sidebar.y>=orb.y+orb.height,'activity starts below the orb')
   assert.ok(sidebar.x>=0&&sidebar.x+sidebar.width<=chat.x,'activity fits beside the conversation')
   assert.doesNotMatch(await activity.innerText(),/主动思考/)
   assert.match(await activity.innerText(),/委派任务/)
   await activity.locator('.digital-home-work-next').click()
   await page.waitForFunction(()=>document.querySelectorAll('.digital-home-work-summary').length>=10)
   await activity.locator('[data-activity-scroll="delegations"]').evaluate(el=>{el.scrollTop=0})
   assert.equal((await page.evaluate(clipAudit,{root:'.digital-home-context'})).cut,0)
  }
  await page.screenshot({path:path.join(artifacts,name+'-chat.png')})
  await page.locator('.digital-home-chat header button').click();await page.waitForTimeout(850)
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('.digital-presence-particles')?.dataset.motion==='still');const frame=await page.locator('.digital-presence-particles').getAttribute('data-frame');await page.waitForTimeout(300);assert.equal(await page.locator('.digital-presence-particles').getAttribute('data-frame'),frame);await page.emulateMedia({reducedMotion:'no-preference'})
  assert.equal(await page.evaluate(()=>window.homeFixture.log.captures),0,'no automatic microphone')
  results.push({name,fits,orbCentered:name!=='landscape',sameOrb:true,audioFrames:true,reducedMotion:true})
 }
 const cdp=await context.newCDPSession(page)
 for(const [width,height,insets] of [[390,844,{top:24,bottom:34,left:0,right:0}],[844,390,{top:0,bottom:16,left:44,right:44}]]){
  await page.setViewportSize({width,height})
  await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets})
  await page.goto('https://presence.invalid/')
  const layout=await page.locator('.digital-home').evaluate(el=>{
   const box=selector=>el.querySelector(selector).getBoundingClientRect().toJSON()
   return {back:box('.digital-home-back'),settings:box('.digital-home-settings:not(.digital-home-face-entry)'),stage:box('.digital-home-stage'),
    history:box('.digital-home-subtitles'),dock:box('.digital-home-voice-dock'),keyboard:box('.digital-home-keyboard')}
  })
  assert.ok(layout.back.top>=insets.top&&layout.back.left>=insets.left,'header clears the top and left safe areas')
  assert.ok(layout.settings.right<=width-insets.right,'header clears the right safe area')
  assert.ok(layout.stage.left>=insets.left&&layout.history.right<=width-insets.right,'stage and history clear the side safe areas: '+JSON.stringify({insets,stage:layout.stage,history:layout.history}))
  assert.ok(Math.max(layout.dock.bottom,layout.keyboard.bottom)<=height-insets.bottom,'controls clear the bottom safe area')
  assert.ok(layout.history.height>0,'history stays available with safe areas')
  await page.screenshot({path:path.join(artifacts,`safe-area-${width}.png`)})
 }
 await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:0,left:0,right:0}})
 await cdp.detach()
 await page.setViewportSize({width:390,height:844});await page.goto('https://presence.invalid/');await page.locator('[data-camera-toggle]').click();await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.srcObject&&document.querySelector('.video-preview-media')?.videoWidth>0);await page.evaluate(()=>window.keptStream=document.querySelector('.video-preview-media').srcObject);await page.locator('.digital-home-dock-transcript').click();assert.equal(await page.evaluate(()=>window.keptStream===document.querySelector('.video-preview-media').srcObject),true);await page.screenshot({path:path.join(artifacts,'camera-chat.png')})
 await page.goto('https://presence.invalid/?skinAvatar=1');await page.locator('[data-custom-avatar]').waitFor();await page.evaluate(()=>window.homeFixture.speaking(true,.75));await page.waitForFunction(()=>Number(document.querySelector('[data-custom-avatar]')?.getAttribute('data-level'))>.7);assert.equal(await page.locator('.digital-presence-orb').count(),0);await page.screenshot({path:path.join(artifacts,'custom-skin.png')})
 await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='webgl'?null:original.call(this,kind,...args)}});await page.goto('https://presence.invalid/');await page.locator('.digital-presence-static').waitFor();await page.screenshot({path:path.join(artifacts,'fallback.png')})
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify({results,cameraPreserved:true,webglFallback:true,errors},null,2));console.log(JSON.stringify({passed:true,artifacts}))
}finally{await page.close();await context.close();await browser.close()}
