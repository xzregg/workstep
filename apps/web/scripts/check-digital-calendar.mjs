// Production calendar/editor/home, isolated synthetic APIs and camera. No application server.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.resolve(root,'../../tmp/digital-calendar'),out=path.join(artifacts,'browser')
await fs.mkdir(artifacts,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.join(root,'tests/fixtures/digital-person-home/index.html')}}})
const html=await fs.readFile(path.join(out,'tests/fixtures/digital-person-home/index.html'))
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']})
const results=[]
try{
 for(const width of [320,390,1023,1024,1440,1920]){
  const height=width<=390?844:1024,page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'}),errors=[]
  page.setDefaultTimeout(8000)
  const now=new Date(),start=new Date(now);start.setHours(14,0,0,0)
  const events=[{id:'sample',revision:'one',content:'**发布复盘**\n\n- 汇总结果\n- 检查遗留问题',starts_at:start.toISOString(),timezone_name:'Asia/Shanghai',reminder_minutes:0,reminder_at:start.toISOString(),reminder_status:'pending'}]
  let failSave=true,creates=0
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url()),method=route.request().method()
   if(url.hostname!=='calendar.invalid')return route.abort()
   if(url.pathname==='/api/digital-person/calendar'){
    if(method==='GET')return route.fulfill({json:{items:events.filter(row=>!row.deleted_at&&row.starts_at>=url.searchParams.get('since')&&row.starts_at<url.searchParams.get('before')),has_more:false,now:new Date().toISOString()}})
    creates++
    if(failSave){failSave=false;return route.fulfill({status:503,json:{detail:'模拟保存失败，请重试'}})}
    const data=route.request().postDataJSON(),event={...data,id:'created',revision:'created-rev',reminder_at:data.starts_at,reminder_status:'pending'}
    events.push(event);return route.fulfill({json:event})
   }
   if(url.pathname==='/api/digital-person/calendar/targets')return route.fulfill({json:{owner:'test',items:[{id:'internal',name:'WorkStep'}]}})
   if(url.pathname.startsWith('/api/digital-person/calendar/')){
    const parts=url.pathname.split('/'),event=events.find(row=>row.id===parts[4]);assert.ok(event)
    if(method==='DELETE'){assert.equal(url.searchParams.get('revision'),event.revision);event.deleted_at=new Date().toISOString();event.revision+='-deleted'}
    if(parts[5]==='restore'){assert.equal(route.request().postDataJSON().revision,event.revision);delete event.deleted_at;event.revision+='-restored'}
    return route.fulfill({json:event})
   }
   if(url.pathname.endsWith('/faces/catalog'))return route.fulfill({json:{revision:'test',settings:{enabled:false},people:[]}})
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}})
   if(url.pathname==='/')return route.fulfill({body:html,contentType:'text/html'})
   const file=path.resolve(out,decodeURIComponent(url.pathname).slice(1))
   if(!file.startsWith(out+path.sep))return route.abort()
   try{return route.fulfill({body:await fs.readFile(file),contentType:{'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'}[path.extname(file)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
  })
  await page.addInitScript(()=>{
   Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const context=canvas.getContext('2d');context.fillStyle='#8ba7af';context.fillRect(0,0,640,360);return canvas.captureStream(5)}})
  })
  await page.goto('https://calendar.invalid/')
  const calendar=page.locator('.digital-home-calendar')
  if(width<=1023){
   assert.equal(await calendar.isVisible(),false)
   const entry=page.getByRole('button',{name:'日程',exact:true})
   assert.equal(await entry.isVisible(),true)
   assert.equal(await page.getByRole('button',{name:'系统日历',exact:true}).count(),0)
   const alignment=await entry.evaluate(button=>{
    const icon=button.querySelector('svg').getBoundingClientRect(),text=button.querySelector('span')?.getBoundingClientRect(),box=button.getBoundingClientRect()
    return {hasLabel:Boolean(text),centerDelta:text?Math.abs(text.y+text.height/2-icon.y-icon.height/2):null,buttonCenterDelta:Math.abs(box.y+box.height/2-icon.y-icon.height/2)}
   })
   assert.equal(alignment.hasLabel,true,'calendar label has an explicit alignment box')
   assert.ok(alignment.centerDelta<=1&&alignment.buttonCenterDelta<=1,'calendar icon and label are vertically centered')
   await page.screenshot({path:path.join(artifacts,`mobile-${width}.png`)})
   results.push({width,mobileCalendarEntry:true,alignment});await page.close();continue
  }
  const day=()=>calendar.locator('[data-today=true]')
  await day().waitFor()
  await day().locator('xpath=self::*[@data-has-events="true"]').waitFor()
  assert.equal(await page.locator('.digital-calendar-popover').count(),0)
  await page.screenshot({path:path.join(artifacts,`calendar-${width}.png`)})
  await day().hover();const popover=page.locator('.digital-calendar-popover')
  await popover.getByText('发布复盘',{exact:true}).waitFor()
  assert.equal(await popover.locator('strong').count()>0,true)
  await page.screenshot({path:path.join(artifacts,`hover-${width}.png`)})
  const box=await popover.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height)
  await page.mouse.move(400,100);await popover.waitFor({state:'detached'})
  const dayDialog=page.locator('[role=dialog]').filter({has:page.locator('.digital-calendar-day-dialog')})
  await day().click()
  await dayDialog.getByText('发布复盘',{exact:true}).waitFor()
  assert.equal(await page.getByRole('dialog',{name:'新增日程',exact:true}).count(),0)
  await page.mouse.move(400,100);assert.equal(await dayDialog.isVisible(),true)
  await page.screenshot({path:path.join(artifacts,`view-day-${width}.png`)})
  await dayDialog.getByRole('button',{name:'新增日程',exact:true}).click()
  const editor=page.getByRole('dialog',{name:'新增日程',exact:true}),input=page.getByRole('textbox',{name:'日程内容',exact:true})
  await input.waitFor();assert.equal(await input.evaluate(el=>el===document.activeElement),true)
  assert.equal(await editor.getByRole('button',{name:'添加',exact:true}).isDisabled(),true)
  await page.mouse.click(5,100);await editor.waitFor({state:'detached'})
  await day().click();await dayDialog.getByRole('button',{name:'新增日程',exact:true}).click();await input.fill('**讨论方案**\n\n- 确认交互\n- 补齐回归')
  await page.mouse.click(5,100);assert.equal(await editor.isVisible(),true)
  await editor.getByRole('button',{name:'添加',exact:true}).click()
  await editor.getByRole('alert').waitFor();assert.match(await input.inputValue(),/讨论方案/)
  await editor.getByRole('textbox',{name:'开始时间',exact:true}).click()
  await page.locator('.ant-picker-panel-container').waitFor()
  const timeColumns=page.locator('.digital-calendar-date-popup .ant-picker-time-panel-column')
  assert.equal(await timeColumns.count(),2,'minute precision has only hour and minute columns')
  await timeColumns.nth(0).getByText('16',{exact:true}).click()
  await timeColumns.nth(1).getByText('30',{exact:true}).click()
  assert.equal(await page.locator('.digital-calendar-date-popup').evaluate(el=>{
   const box=el.getBoundingClientRect(),target=document.elementFromPoint(box.x+box.width/2,box.y+Math.min(box.height/2,60));return Boolean(target&&el.contains(target))
  }),true,'time picker is above the editor backdrop and reachable')
  await page.screenshot({path:path.join(artifacts,`time-${width}.png`),animations:'disabled'})
  await page.locator('.digital-calendar-date-popup').getByRole('button',{name:/确\s*定/}).click()
  assert.match(await editor.getByRole('textbox',{name:'开始时间',exact:true}).inputValue(),/16:30$/)
  await page.screenshot({path:path.join(artifacts,`editor-${width}.png`)})
  await editor.getByRole('button',{name:'添加',exact:true}).click();await editor.waitFor({state:'detached'});assert.equal(creates,2)
  await day().hover();await popover.getByText('讨论方案',{exact:true}).waitFor()
  const entry=popover.locator('.digital-calendar-entry').filter({hasText:'讨论方案'})
  await entry.getByRole('button',{name:'删除日程',exact:true}).click()
  await popover.getByText('讨论方案',{exact:true}).waitFor({state:'hidden'})
  assert.equal(await page.getByRole('button',{name:'撤销',exact:true}).count(),0)
  assert.ok(events.find(row=>row.id==='created').deleted_at,'deletion commits directly')
  await page.mouse.move(400,100);await popover.waitFor({state:'detached'})
  const before=await calendar.boundingBox()
  await page.locator('.digital-home-voice-dock [data-camera-toggle]').click()
  await page.locator('.video-preview-window[data-video-ready=true]').waitFor()
  assert.deepEqual(await calendar.boundingBox(),before,'floating camera does not move calendar')
  const header=await page.locator('.video-preview-header-title').boundingBox()
  await page.mouse.move(header.x+40,header.y+8);await page.mouse.down();await page.mouse.move(header.x-300,header.y+80,{steps:6});await page.mouse.up()
  await page.screenshot({path:path.join(artifacts,`camera-${width}.png`)})
  if(width===1440){
   await day().click();await dayDialog.getByRole('button',{name:'新增日程',exact:true}).click();await input.fill('窄屏保留的日程草稿')
   await page.setViewportSize({width:390,height:844})
   const narrow=await editor.boundingBox();assert.ok(narrow.x>=0&&narrow.width<=390&&narrow.y+narrow.height<=844)
   await page.screenshot({path:path.join(artifacts,'editor-390.png')})
  }
  assert.deepEqual(errors,[]);results.push({width,calendar:true,markdown:true,quickEntry:true,blankDismiss:true,saveRecovery:true,directDelete:true,floatingCamera:true})
  await page.close()
 }
}finally{await browser.close()}
await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
