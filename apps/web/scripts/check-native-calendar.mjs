import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=path.resolve(import.meta.dirname,'..'),output=path.resolve(root,'../../tmp/native-calendar/browser')
await fs.mkdir(output,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:output,emptyOutDir:true,rolldownOptions:{input:path.join(root,'tests/fixtures/native-calendar/index.html')}}})
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const results=[]
try{for(const width of [320,390,1024,1440]){
 const page=await browser.newPage({viewport:{width,height:900}}),operations=new Map(),errors=[],events=[]
 let permission='not_determined',deleted=0
 const target=()=>({id:permission==='granted'?'calendar-target':'needs-calendar',name:'个人日历',device_id:'phone',device_name:'测试手机',permission,online:true})
 page.on('pageerror',error=>{errors.push(error.message);console.error('Native calendar fixture:',error.message)})
 await page.addInitScript(()=>{
  let deletionAttempt=0
  window.__calendarPermission='not_determined'
  window.__nativeCalls=[]
  window.__readCalls=[]
  const invoke=async(action,input)=>{
   if(action==='identity')return {device_id:'phone',key:'k'.repeat(40),name:'测试手机',platform:'android'}
   if(action==='permission')window.__calendarPermission='granted'
   if(action==='settings')window.__nativeCalls.push('settings')
   if(action==='events'){
    window.__readCalls.push(input)
    assertWindowRange(input)
    await new Promise(resolve=>setTimeout(resolve,40))
    return {items:[{system_id:'existing-phone-event',calendar_name:'手机个人日历',content:'**手机原有日程**',starts_at:new Date().toISOString(),timezone_name:'Asia/Shanghai',all_day:false,workstep_owned:false}],has_more:false}
   }
   if(['status','permission'].includes(action))return {permission:window.__calendarPermission,calendars:window.__calendarPermission==='granted'?[{id:'c',name:'个人日历'}]:[]}
   if(action==='execute'){
    await new Promise(resolve=>setTimeout(resolve,40))
    window.__nativeCalls.push(input.operation.action+':'+input.item.id)
    if(input.operation.action==='delete'&&++deletionAttempt===1)return {item_id:input.item.id,status:'failed',error_code:'provider_error'}
    return {item_id:input.item.id,status:'succeeded',verification:input.operation.action==='delete'?'absent':'present',system_id:input.item.system_id||input.item.id}
   }
   return {}
  }
  function assertWindowRange(input){if(new Date(input.before)-new Date(input.since)>62*86400000)throw new Error('Unbounded system calendar read')}
  window.WorkStepCalendar={onmessage:null,postMessage(raw){const input=JSON.parse(raw);void invoke(input.action,input.value).then(result=>this.onmessage?.({data:JSON.stringify({id:input.id,result})})).catch(error=>this.onmessage?.({data:JSON.stringify({id:input.id,error:error.message})}))}}
  class Socket{
   static OPEN=1;static CONNECTING=0;readyState=0
   constructor(){window.__calendarSocket=this;setTimeout(()=>{this.readyState=1;this.onopen?.()},0)}
   send(raw){const data=JSON.parse(raw);if(data.device_id)queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:'ready'})}))}
   close(){this.readyState=3;this.onclose?.()}
  }
  window.WebSocket=Socket
 })
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url()),pathname=url.pathname,body=route.request().postDataJSON()
  const base='/api/digital-person/calendar'
  if(pathname===base){
   if(route.request().method()==='GET')return route.fulfill({json:{items:events,has_more:false}})
   const event={...body,id:'quick',revision:'one',reminder_status:'pending',reminder_at:body.starts_at};events.push(event)
   return route.fulfill({json:event})
  }
  if(pathname===base+'/quick'&&route.request().method()==='DELETE'){events.splice(0);return route.fulfill({json:{id:'quick',revision:'deleted'}})}
  if(pathname===base+'/targets')return route.fulfill({json:{owner:'user',items:[{id:'internal',name:'WorkStep',device_id:'',permission:'granted',online:true},target()]}})
  if(pathname===base+'/devices'){permission=body.permission;return route.fulfill({json:{owner:'user',targets:[target()]}})}
  if(pathname===base+'/operations'){
   assert.equal(body.target_id,'calendar-target','mobile creation defaults to the real phone calendar')
   const op={id:'phone-create',action:'create',target_id:body.target_id,calendar_id:'c',device_id:'phone',status:'queued',token:'execution-token',cancel_requested:false,
    items:[{id:'phone-item',event_id:'phone-event',status:'queued',draft:{content:body.content,starts_at:body.starts_at,timezone_name:body.timezone_name,reminder_minutes:body.reminder_minutes},duration_minutes:30}]}
   operations.set(op.id,op)
   await route.fulfill({json:op})
   await page.evaluate(()=>window.__calendarSocket.onmessage({data:JSON.stringify({type:'operation_available'})}))
   return
  }
  if(pathname.endsWith('/pending'))return route.fulfill({json:{items:[...operations.values()].filter(op=>!['succeeded','partial','failed','cancelled'].includes(op.status))}})
  if(pathname.includes('/operations/')){
   const id=pathname.match(/operations\/([^/]+)/)?.[1],op=operations.get(id);assert.ok(op)
   if(pathname.endsWith('/claim'))op.status=permission!=='granted'?'needs_permission':!op.calendar_id?'needs_calendar':'executing'
   else if(pathname.endsWith('/target')){op.calendar_id='c';op.target_id=body.target_id;op.status='queued'}
   else if(pathname.endsWith('/receipts')){
    const item=op.items.find(item=>item.id===body.receipt.item_id);assert.ok(item)
    item.status=body.receipt.status;if(item.status==='succeeded'&&op.action==='delete')deleted++
    if(op.id==='phone-create'&&item.status==='succeeded')events.push({...item.draft,id:item.event_id,target_id:op.target_id,revision:'native-revision',reminder_status:'system',reminder_at:item.draft.starts_at})
    const statuses=op.items.map(row=>row.status)
    op.status=statuses.some(status=>status==='queued')?'executing':statuses.every(status=>status==='succeeded')?'succeeded':'partial'
    return route.fulfill({json:{id:op.id,status:op.status,cancel_requested:op.cancel_requested,item:{id:item.id,status:item.status,error_code:body.receipt.error_code}}})
   }else if(pathname.endsWith('/resume')){op.items.forEach(item=>{if(item.status==='failed')item.status='queued'});op.status='queued'}
   else if(pathname.endsWith('/cancel')){op.cancel_requested=true;op.status='cancelled'}
   return route.fulfill({json:op})
  }
  if(pathname.startsWith('/api/'))return route.fulfill({json:{}})
  const file=pathname==='/'?path.join(output,'tests/fixtures/native-calendar/index.html'):path.join(output,pathname)
  try{return route.fulfill({body:await fs.readFile(file),contentType:pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html'})}catch{return route.fulfill({status:404})}
 })
 await page.goto('https://calendar.invalid/')
 const dayDialog=page.locator('[role=dialog]').filter({has:page.locator('.digital-calendar-day-dialog')})
 assert.deepEqual(errors,[])
 await page.getByRole('checkbox',{name:'同步到系统日历',exact:true}).check()
 await page.getByRole('dialog',{name:'系统日历',exact:true}).getByRole('button',{name:'关闭',exact:true}).click()
 if(width<=390){
  await page.getByRole('button',{name:'日程',exact:true}).click()
  await page.getByRole('dialog',{name:'日历',exact:true}).getByRole('button',{name:'立即授权',exact:true}).waitFor()
  assert.equal(await page.locator('.digital-calendar-panel').count(),0)
  await page.getByRole('button',{name:'立即授权',exact:true}).click()
  await page.locator('.digital-calendar-panel').waitFor()
  await page.locator('.digital-calendar-panel [data-today=true][data-has-events=true]').click()
  await dayDialog.getByText('手机原有日程',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'立即授权',exact:true}).count(),0)
  await dayDialog.getByRole('button',{name:'关闭',exact:true}).click()
  await page.getByRole('dialog',{name:'日历',exact:true}).getByRole('button',{name:'关闭',exact:true}).click()
  await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/calendar/devices')),page.evaluate(()=>{window.__calendarPermission='not_determined';window.dispatchEvent(new Event('focus'))})])
 }
 await page.getByRole('button',{name:'选择日历',exact:true}).click()
 await page.getByRole('dialog',{name:'系统日历'}).waitFor()
 await page.screenshot({path:path.join(output,`permission-${width}.png`)})
 // A chat/CLI operation arrives through the dedicated device channel.
 const items=Array.from({length:30},(_,index)=>({id:'day-'+index,event_id:'event-'+index,status:'queued',draft:{content:'**运动**',starts_at:'2030-01-01T00:00:00Z',timezone_name:'Asia/Shanghai',reminder_minutes:0},duration_minutes:30}))
 operations.set('batch',{id:'batch',plan_id:'plan',action:'create',target_id:'needs-calendar',calendar_id:'',device_id:'phone',status:'queued',items,token:'execution-token',cancel_requested:false})
 await page.evaluate(()=>window.__calendarSocket.onmessage({data:JSON.stringify({type:'operation_available',operation_id:'batch'})}))
 await page.getByText(/等待授权/).waitFor()
 await page.getByRole('button',{name:'立即授权',exact:true}).click()
 await page.getByText(/请选择日历/).waitFor()
 await page.getByRole('dialog',{name:'系统日历',exact:true}).getByLabel('日历',{exact:true}).selectOption('calendar-target')
 await page.getByRole('button',{name:'使用此日历'}).click()
 const latency=await page.evaluate(()=>new Promise(resolve=>{const start=performance.now();setTimeout(()=>resolve(performance.now()-start),30)}))
 assert.ok(latency<200,'native execution does not block the renderer event loop')
 await page.waitForFunction(()=>window.nativeCalendarFixture.operation()?.id==='batch'&&window.nativeCalendarFixture.operation()?.status==='succeeded')
 assert.equal(await page.getByRole('dialog',{name:'系统日历',exact:true}).count(),0,'successful operations do not open a result dialog')
 assert.equal((await page.evaluate(()=>window.__nativeCalls)).length,30)
 await page.screenshot({path:path.join(output,`batch-${width}.png`)})
 operations.set('delete',{id:'delete',plan_id:'plan',action:'delete',target_id:'calendar-target',calendar_id:'c',device_id:'phone',status:'queued',items:items.slice(0,2).map(item=>({...item,id:'delete-'+item.id,system_id:item.id,status:'queued'})),token:'delete-token',cancel_requested:false})
 await page.evaluate(()=>window.__calendarSocket.onmessage({data:JSON.stringify({type:'operation_available',operation_id:'delete'})}))
 await page.getByText(/部分完成 · 1\/2/).waitFor()
 const box=await page.getByRole('dialog',{name:'系统日历'}).boundingBox()
 assert.ok(box.x>=0&&box.x+box.width<=width&&box.height<=900)
 assert.equal(deleted,1,'only a verified deletion is committed')
 await page.screenshot({path:path.join(output,`partial-delete-${width}.png`)})
 await page.getByRole('button',{name:'继续／核实未完成项'}).click()
 await page.waitForFunction(()=>window.nativeCalendarFixture.operation()?.id==='delete'&&window.nativeCalendarFixture.operation()?.status==='succeeded')
 assert.equal(await page.getByRole('dialog',{name:'系统日历',exact:true}).count(),0)
 assert.equal(deleted,2)
 assert.equal((await page.evaluate(()=>window.__nativeCalls)).filter(value=>value.startsWith('delete:')).length,3)
 await page.evaluate(()=>{window.__calendarPermission='denied';window.dispatchEvent(new Event('focus'))})
 await page.getByRole('button',{name:'选择日历',exact:true}).click()
 await page.getByRole('button',{name:'打开应用设置',exact:true}).click()
 assert.equal((await page.evaluate(()=>window.__nativeCalls)).filter(value=>value==='settings').length,1)
 await page.screenshot({path:path.join(output,`settings-${width}.png`)})
 await page.evaluate(()=>{window.__calendarPermission='granted';window.dispatchEvent(new Event('focus'))})
 await page.getByRole('button',{name:'打开应用设置',exact:true}).waitFor({state:'hidden'})
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 if(width<=390){
  await page.getByRole('button',{name:'日程',exact:true}).click()
  const calendar=page.locator('.digital-calendar-panel')
  await calendar.waitFor()
  assert.equal(await page.getByRole('button',{name:'立即授权',exact:true}).count(),0)
  await calendar.locator('[data-today=true][data-has-events=true]').waitFor()
  const dateAlignment=await calendar.locator('.digital-calendar-day').evaluateAll(days=>days.map(day=>{
   const box=day.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(day)
   const text=range.getBoundingClientRect()
   return Math.abs(box.x+box.width/2-text.x-text.width/2)
  }))
  assert.ok(dateAlignment.every(delta=>delta<=1),'date numbers are centered in their cells, including the selected date')
  const addBox=await calendar.getByRole('button',{name:'新增日程',exact:true}).boundingBox()
  assert.ok(addBox.height>=44&&addBox.width>200,'the frequent add action is a large labeled primary button')
  await page.screenshot({path:path.join(output,`calendar-${width}.png`)})
  await calendar.locator('[data-today=true]').click()
  const editor=page.getByRole('dialog',{name:'新增日程',exact:true})
  assert.equal(await editor.count(),0)
  await dayDialog.getByText('手机原有日程',{exact:true}).waitFor()
  const original=dayDialog.locator('.digital-calendar-entry').filter({hasText:'手机原有日程'})
  assert.equal(await original.getByRole('button',{name:'删除日程',exact:true}).count(),0)
  await dayDialog.getByRole('button',{name:'关闭',exact:true}).click()
  await page.getByRole('dialog',{name:'日历',exact:true}).getByRole('button',{name:'关闭',exact:true}).click()
  await page.getByRole('checkbox',{name:'同步到系统日历',exact:true}).uncheck()
  const nativeReadsBefore=await page.evaluate(()=>window.__readCalls.length)
  await page.getByRole('button',{name:'日程',exact:true}).click()
  await calendar.locator('[data-today=true]').click()
  await editor.waitFor()
  assert.equal(await editor.getByLabel('保存到',{exact:true}).count(),0)
  await editor.getByRole('textbox',{name:'日程内容',exact:true}).fill('**手机快速添加**\n\n- 喝水')
  const saveGeometry=await editor.getByRole('button',{name:'添加',exact:true}).evaluate(button=>{
   const box=button.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(button)
   const text=range.getBoundingClientRect()
   return {height:box.height,width:box.width,centerDelta:Math.abs(box.x+box.width/2-text.x-text.width/2)}
  })
  assert.ok(saveGeometry.height>=44&&saveGeometry.width>200&&saveGeometry.centerDelta<=1,'save uses a large primary target with centered text')
  await page.screenshot({path:path.join(output,`editor-${width}.png`)})
  await editor.getByRole('button',{name:'添加',exact:true}).click()
  await editor.waitFor({state:'hidden'})
  await calendar.locator('[data-today=true]').click()
  await dayDialog.getByText('手机快速添加',{exact:true}).waitFor()
  assert.equal(await dayDialog.locator('strong').filter({hasText:'手机快速添加'}).count(),1)
  assert.equal(await editor.count(),0,'an occupied day opens its agenda instead of creation')
  await page.screenshot({path:path.join(output,`view-day-${width}.png`)})
  await dayDialog.getByRole('button',{name:'新增日程',exact:true}).click()
  await editor.waitFor()
  await editor.getByRole('button',{name:'取消',exact:true}).click()
  await calendar.locator('[data-today=true]').click()
  await dayDialog.getByRole('button',{name:'删除日程',exact:true}).click()
  await dayDialog.getByText('手机快速添加',{exact:true}).waitFor({state:'hidden'})
  await dayDialog.getByRole('button',{name:'关闭',exact:true}).click()
  await page.getByRole('dialog',{name:'日历',exact:true}).getByRole('button',{name:'关闭',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.__readCalls.length),nativeReadsBefore,'disabled sync never reads the system calendar')
  await page.getByRole('checkbox',{name:'同步到系统日历',exact:true}).check()
  await page.screenshot({path:path.join(output,`sync-setting-${width}.png`)})
  await page.getByRole('button',{name:'日程',exact:true}).click()
  await page.locator('.digital-calendar-panel').waitFor()
  await page.locator('.digital-calendar-panel').getByRole('button',{name:'新增日程',exact:true}).click()
  await editor.getByRole('textbox',{name:'日程内容',exact:true}).fill('写入手机系统日历')
  await editor.getByRole('button',{name:'添加',exact:true}).click()
  await page.waitForFunction(()=>window.nativeCalendarFixture.operation()?.id==='phone-create'&&window.nativeCalendarFixture.operation()?.status==='succeeded')
  assert.equal(await page.getByRole('dialog',{name:'系统日历',exact:true}).count(),0)
  assert.equal((await page.evaluate(()=>window.__nativeCalls)).includes('create:phone-item'),true)
  assert.equal(events.some(event=>event.content==='写入手机系统日历'&&event.target_id==='calendar-target'),true,'verified system creation also exists in WorkStep')
  assert.ok((await page.evaluate(()=>window.__readCalls)).length>0)
 }
 assert.deepEqual(errors,[])
 results.push({width,permission:true,batch:30,partialDelete:true,retryOnlyFailed:true,opensSettings:true,rechecksOnReturn:true,...(width<=390?{mobileAuthorizationGate:true,mobileCalendar:true,quickCreateDelete:true}:{})})
 await page.close()
}}finally{await browser.close()}
await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
