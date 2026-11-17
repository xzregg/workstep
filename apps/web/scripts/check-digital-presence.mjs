import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.resolve(root,'../../tmp/digital-presence-implementation'),out=path.join(artifacts,'browser')
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
   if(url.pathname.endsWith('/activity/records')){
    const runOffset=Number(url.searchParams.get('run_offset')||0),taskOffset=Number(url.searchParams.get('delegation_offset')||0)
    const runs=Array.from({length:12},(_,i)=>({id:`r${i+1}`,status:i===0?'failed':'silent',outcome:i===0?null:i===1?{sent:1,failed:0,affinity_increased:2,affinity_decreased:0,message_preview:'早上好，昨天说的入口我记住了。'}:{sent:0,failed:0,affinity_increased:0,affinity_decreased:0},summary:i===0?'本轮思考未完成':i===1?'整理 100 条消息（10 个会话），新增 18 条记忆':'尚未领取本轮待整理消息，保留待处理状态',created_at:`2026-11-17T${String(10-Math.floor(i/6)).padStart(2,'0')}:${String(54-i*3%60).padStart(2,'0')}:00Z`}))
    const delegations=Array.from({length:12},(_,i)=>({id:`work${i}`,project_id:'p',session_id:'s',instruction:i===0?'修复 WorkStep 视频摄像头功能，用户当前点击打开摄像头后界面显示发送消息时附上当前画面':'整理项目工作安排',status:i===0?'completed':'running',notification_state:i===0?'notified':'pending',created_at:'2026-11-17T10:42:00Z'}))
    return route.fulfill({json:{reflection_count:237,run_total:100,delegation_total:12,checking:false,delegations:delegations.slice(taskOffset,taskOffset+5),runs:runs.slice(runOffset,runOffset+5)}})
   }
   if(url.pathname.includes('/digital-person/runs/'))return route.fulfill({json:{id:'fixture',status:'failed',draft_summary:'我想跟进昨天的安排。\n'+('这轮交流让我记住了新的入口位置。'.repeat(18)),failure_reason:'未能确认思考内容对应的消息，本轮结果未采用。',outcome:{sent:0,failed:0,affinity_increased:0,affinity_decreased:0},error:'检查结果来源无效',created_at:'2026-11-17T10:54:00Z'}})
   if(url.pathname.endsWith('/faces/catalog'))return route.fulfill({json:{revision:'fixture',settings:{enabled:false,include_people:false,show_names:false},people:[]}})
   if(url.pathname.endsWith('/affect'))return route.fulfill({json:{state:{person_id:'p',name:'会话作者',affinity:68,emotion:'calm',valence:0,arousal:0,updated_at:null,history:[]}}})
   return route.fulfill({json:{}})
  }
  if(url.pathname==='/')return route.fulfill({body:html,contentType:'text/html'})
  const file=path.resolve(out,decodeURIComponent(url.pathname).replace(/^\//,''));if(!file.startsWith(out+path.sep))return route.abort()
  try{return route.fulfill({body:await fs.readFile(file),contentType:{'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'}[path.extname(file)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
 })
 for(const [name,width,height]of [['mobile',390,844],['narrow',320,640],['landscape',844,390],['desktop',1440,1024],['wide',2560,1440]]){
  await page.setViewportSize({width,height});await page.goto('https://presence.invalid/');await page.locator('.digital-presence-particles[data-frame]').waitFor()
  assert.equal(await page.locator('.digital-home-identity').count(),1)
  assert.match(await page.locator('.digital-home-presence-info').innerText(),/237/)
  assert.match(await page.locator('.digital-home-presence-info').innerText(),/68/)
  await page.screenshot({path:path.join(artifacts,name+'-idle.png')})
  await page.evaluate(()=>{window.settingsOpened=0;window.addEventListener('workstep:open-digital-person-settings',()=>window.settingsOpened++)})
  for(const [selector,kind]of [['.digital-home-identity','profile'],['.digital-home-affinity','affinity'],['.digital-home-metric:not(.digital-home-affinity)','reflection']]){
   await page.locator(selector).click();await page.locator('.digital-home-detail-panel').waitFor();assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');await page.screenshot({path:path.join(artifacts,name+'-detail-'+kind+'.png')});
   if(kind==='reflection'){
    assert.equal(await page.locator('.digital-home-detail-pages strong').count(),0)
    assert.equal(await page.locator('.digital-home-detail-panel>footer .digital-home-detail-pages').count(),1)
    if(width>1023){let audit=await page.evaluate(clipAudit,{root:'.digital-home-detail-backdrop'});assert.equal(audit.cut,0,JSON.stringify(audit));await page.locator('.digital-home-detail-run>.btn').first().hover();audit=await page.evaluate(clipAudit,{root:'.digital-home-detail-backdrop'});assert.equal(audit.cut,0,JSON.stringify(audit))}
    await page.locator('.digital-home-detail-run>.btn').first().click();await page.locator('.digital-person-run-detail p').first().waitFor();assert.match(await page.locator('.digital-person-run-detail').innerText(),/好感度 0/);assert.doesNotMatch(await page.locator('.digital-person-run-detail').innerText(),/检查结果来源无效/);await page.screenshot({path:path.join(artifacts,name+'-detail-reflection-expanded.png')});
    const footer=await page.locator('.digital-home-detail-panel>footer').boundingBox(),content=await page.locator('.digital-home-detail-content').boundingBox();assert.ok(content.y+content.height<=footer.y+1,'pagination stays below scrollable content')
    if(width>1023){const audit=await page.evaluate(clipAudit,{root:'.digital-home-detail-backdrop'});assert.equal(audit.cut,0,JSON.stringify(audit))}
   }
   await page.locator('.digital-home-detail-close').click();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.settingsOpened),0)
  }

  const fits=await page.evaluate(()=>({width:document.documentElement.scrollWidth<=innerWidth,height:document.documentElement.scrollHeight<=innerHeight+1}));assert.deepEqual(fits,{width:true,height:true})
  if(name!=='landscape'){const stage=await page.locator('.digital-home-stage').boundingBox();assert.ok(Math.abs(stage.x+stage.width/2-width/2)<2,'orb stays centered')}
  const header=await page.locator('.digital-home-header').boundingBox(),back=await page.locator('.digital-home-back').boundingBox();assert.ok(width>1023?Math.abs(back.x+back.width-(width-32))<2:Math.abs(back.x-20)<2)
  assert.ok(header.height>0)
  if(width>1023){
   const layout=await page.evaluate(()=>{const context=document.querySelector('.digital-home-context'),identity=document.querySelector('.digital-home-presence-info'),thoughts=document.querySelector('.digital-home-reflections'),tasks=document.querySelector('.digital-home-work');return {top:context.getBoundingClientRect().top,identityTop:identity.getBoundingClientRect().top,ratio:thoughts.getBoundingClientRect().height/tasks.getBoundingClientRect().height,scrollbars:[...document.querySelectorAll('.digital-home-activity-scroll')].map(el=>getComputedStyle(el).scrollbarWidth)}})
   assert.ok(Math.abs(layout.top-layout.identityTop)<1,'left and right share the top baseline');assert.ok(Math.abs(layout.ratio-1.5)<.02,'thoughts/tasks split 60/40');assert.deepEqual(layout.scrollbars,['none','none'])
   const taskLine=await page.locator('.digital-home-work-summary').first().evaluate(el=>{const title=el.querySelector('strong'),time=el.querySelector('time');return {height:title.getBoundingClientRect().height,line:parseFloat(getComputedStyle(title).lineHeight),titleTop:title.getBoundingClientRect().top,timeTop:time.getBoundingClientRect().top,timeText:time.textContent,tooltip:time.title,timeRight:time.getBoundingClientRect().right,contextRight:el.closest('.digital-home-context').getBoundingClientRect().right}});assert.ok(taskLine.height<=taskLine.line+1,'delegated task title uses one line');assert.ok(Math.abs(taskLine.titleTop-taskLine.timeTop)<1);assert.match(taskLine.timeText,/\d{2}:\d{2}/);assert.ok(taskLine.tooltip);assert.ok(taskLine.timeRight<=taskLine.contextRight+1,'task time stays visible beside long text')
   assert.equal(await page.locator('.digital-home-thought-event').count(),5)
   await page.locator('[data-activity-scroll="runs"]').evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'))})
   await page.waitForFunction(()=>document.querySelectorAll('.digital-home-thought-event').length===10)
   assert.equal(await page.locator('.digital-home-work-summary').count(),5,'thought pagination does not append task rows')
   await page.locator('[data-activity-scroll="runs"]').evaluate(el=>{el.scrollTop=0})
  }
  if(width>1440){const left=await page.locator('.digital-home-context').boundingBox(),right=await page.locator('.digital-home-presence-info').boundingBox();assert.ok(left.x>=(width-1440)/2+30);assert.ok(right.x+right.width<=width-(width-1440)/2-30)}
  await page.evaluate(()=>window.homeFixture.setActivity('think'));await page.waitForFunction(()=>document.querySelector('.digital-presence-particles')?.dataset.presencePhase==='thinking');await page.waitForTimeout(700);await page.screenshot({path:path.join(artifacts,name+'-thinking.png')})
  await page.evaluate(()=>window.homeFixture.speaking(true,.8));await page.waitForFunction(()=>Number(document.querySelector('.digital-presence-particles')?.dataset.level)>.5);await page.screenshot({path:path.join(artifacts,name+'-speaking.png')})
  await page.evaluate(()=>window.homeFixture.speaking(false,0));await page.evaluate(()=>window.homeFixture.setActivity('idle'))
  await page.evaluate(()=>window.keptOrb=document.querySelector('.digital-presence-particles'))
  const before=await page.locator('.digital-home-stage').boundingBox()
  if(width>1023){assert.equal(await page.locator('[data-recent-message]').count(),0,'chat messages are not repeated in the sidebar');assert.match(await page.locator('.digital-home-context').innerText(),/主动动态/);assert.match(await page.locator('.digital-home-context').innerText(),/已发送 1 条消息/);assert.match(await page.locator('.digital-home-context').innerText(),/好感度 \+2/);await page.locator('.digital-home-dock-transcript').click()}else await page.locator('.digital-home-transcript-button').click()
  if(width>1023){await page.waitForTimeout(140);const middle=await page.locator('.digital-home-stage').boundingBox();assert.ok(middle.width<before.width&&middle.width>220);await page.screenshot({path:path.join(artifacts,'desktop-chat-moving.png')})}
  await page.waitForTimeout(900);assert.equal(await page.locator('.digital-home-chat').isVisible(),true)
  assert.equal(await page.evaluate(()=>window.keptOrb===document.querySelector('.digital-presence-particles')),true)
  await page.screenshot({path:path.join(artifacts,name+'-chat.png')})
  await page.locator('.digital-home-chat header button').click();await page.waitForTimeout(850)
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('.digital-presence-particles')?.dataset.motion==='still');const frame=await page.locator('.digital-presence-particles').getAttribute('data-frame');await page.waitForTimeout(300);assert.equal(await page.locator('.digital-presence-particles').getAttribute('data-frame'),frame);await page.emulateMedia({reducedMotion:'no-preference'})
  assert.equal(await page.evaluate(()=>window.homeFixture.log.captures),0,'no automatic microphone')
  results.push({name,fits,orbCentered:name!=='landscape',sameOrb:true,audioFrames:true,reducedMotion:true})
 }
 await page.setViewportSize({width:390,height:844});await page.goto('https://presence.invalid/');await page.locator('[data-camera-toggle]').click();await page.waitForFunction(()=>document.querySelector('.video-preview-media')?.srcObject&&document.querySelector('.video-preview-media')?.videoWidth>0);await page.evaluate(()=>window.keptStream=document.querySelector('.video-preview-media').srcObject);await page.locator('.digital-home-transcript-button').click();assert.equal(await page.evaluate(()=>window.keptStream===document.querySelector('.video-preview-media').srcObject),true);await page.screenshot({path:path.join(artifacts,'camera-chat.png')})
 await page.goto('https://presence.invalid/?skinAvatar=1');await page.locator('[data-custom-avatar]').waitFor();await page.evaluate(()=>window.homeFixture.speaking(true,.75));await page.waitForFunction(()=>Number(document.querySelector('[data-custom-avatar]')?.getAttribute('data-level'))>.7);assert.equal(await page.locator('.digital-presence-orb').count(),0);await page.screenshot({path:path.join(artifacts,'custom-skin.png')})
 await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='webgl'?null:original.call(this,kind,...args)}});await page.goto('https://presence.invalid/');await page.locator('.digital-presence-static').waitFor();await page.screenshot({path:path.join(artifacts,'fallback.png')})
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify({results,cameraPreserved:true,webglFallback:true,errors},null,2));console.log(JSON.stringify({passed:true,artifacts}))
}finally{await page.close();await context.close();await browser.close()}
