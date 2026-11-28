// Production components; synthetic API storage, no application server or user data.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.resolve(root,'../../tmp/calendar-range'),out=path.join(artifacts,'browser')
await fs.mkdir(artifacts,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.join(root,'tests/fixtures/calendar-range/index.html')}}})
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const results=[]
try{
 for(const width of [320,390,1023,1024,1440]){
  const page=await browser.newPage({viewport:{width,height:900},timezoneId:'Asia/Shanghai',reducedMotion:'reduce',hasTouch:width<1024}),events=[],errors=[]
  page.setDefaultTimeout(10000)
  await page.clock.install({time:new Date('2030-01-01T01:00:00Z')})
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url()),method=route.request().method()
   if(url.hostname!=='calendar.invalid')return route.abort()
   if(url.pathname==='/api/digital-person/calendar'){
    if(method==='GET')return route.fulfill({json:{items:events,has_more:false,now:new Date().toISOString()}})
    const data=route.request().postDataJSON(),event={...data,id:'saved',revision:'r1',created_at:'',updated_at:'',reminder_at:data.starts_at,reminder_status:'pending'}
    events.push(event);return route.fulfill({json:event})
   }
   if(url.pathname==='/api/digital-person/calendar/saved'&&method==='PUT'){
    Object.assign(events[0],route.request().postDataJSON(),{revision:'r2'});return route.fulfill({json:events[0]})
   }
   if(url.pathname==='/api/digital-person/calendar/targets')return route.fulfill({json:{owner:'test',items:[{id:'internal',name:'WorkStep'}]}})
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}})
   const file=url.pathname==='/'?path.join(out,'tests/fixtures/calendar-range/index.html'):path.resolve(out,url.pathname.slice(1))
   if(!file.startsWith(out+path.sep))return route.abort()
   return route.fulfill({body:await fs.readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'})
  })
  await page.goto('https://calendar.invalid/')
  await page.locator('[data-today=true]').click()
  const editor=page.locator('.digital-calendar-editor'),start=page.getByRole('textbox',{name:'开始时间',exact:true}),end=page.getByRole('textbox',{name:'结束时间',exact:true})
  const choose=async(input,date,hour,minute)=>{
   await input.click()
   const popup=page.locator('.digital-calendar-date-popup:visible').last()
   await popup.locator(`td[title="${date}"]`).click()
   await popup.locator(`td.ant-picker-cell-selected[title="${date}"]`).waitFor()
   const columns=popup.locator('.ant-picker-time-panel-column')
   await columns.nth(0).getByText(hour,{exact:true}).click()
   await columns.nth(1).getByText(minute,{exact:true}).click()
   await popup.getByRole('button',{name:/确\s*定/}).click()
   await popup.waitFor({state:'hidden'})
   assert.equal(await input.inputValue(),`${date} ${hour}:${minute}`)
  }
  assert.equal(await start.inputValue(),'2030-01-01 09:05')
  assert.equal(await end.inputValue(),'2030-01-01 09:35')
  await page.getByRole('textbox',{name:'日程内容',exact:true}).fill('跨日会议')
  await choose(end,'2030-01-01','10','30')
  assert.equal(await end.inputValue(),'2030-01-01 10:30')
  await choose(start,'2030-01-01','23','45')
  assert.equal(await end.inputValue(),'2030-01-02 00:15')
  await choose(end,'2030-01-01','23','45')
  await editor.getByRole('alert').waitFor()
  assert.match(await editor.getByRole('alert').textContent(),/结束时间必须晚于开始时间/)
  assert.equal(await editor.getByRole('button',{name:'添加',exact:true}).isDisabled(),true)
  await choose(end,'2030-01-01','22','45')
  assert.match(await editor.getByRole('alert').textContent(),/结束时间必须晚于开始时间/)
  await choose(end,'2030-01-02','01','20')
  const geometry=await page.locator('.digital-calendar-time-range').evaluate(row=>{
   const boxes=[...row.querySelectorAll('.ant-picker')].map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})
   return {boxes,previewLines:[...row.querySelectorAll('.digital-calendar-time-preview')].map(el=>[...el.children].map(child=>child.getBoundingClientRect().y)),overflow:row.scrollWidth>row.clientWidth,viewport:document.documentElement.scrollWidth>innerWidth}
  })
  assert.equal(geometry.boxes[0].y,geometry.boxes[1].y)
  assert.equal(geometry.overflow,false);assert.equal(geometry.viewport,false)
  for(const [dateY,timeY] of geometry.previewLines)assert.equal(dateY,timeY,'mobile date and time share one line when they fit')
  await page.screenshot({path:path.join(artifacts,`editor-${width}.png`)})
  await editor.getByRole('button',{name:'添加',exact:true}).click()
  await editor.waitFor({state:'detached'})
  assert.equal(events[0].duration_minutes,95)
  assert.equal(events[0].starts_at,'2030-01-01T15:45:00.000Z')
  await page.locator('[data-today=true]').click()
  await page.getByRole('button',{name:'编辑日程',exact:true}).click()
  assert.equal(await start.inputValue(),'2030-01-01 23:45')
  assert.equal(await end.inputValue(),'2030-01-02 01:20')
  await choose(end,'2030-01-02','02','20')
  await editor.getByRole('button',{name:'保存',exact:true}).click()
  await editor.waitFor({state:'detached'})
  assert.equal(events[0].duration_minutes,155)
  await page.locator('[data-today=true]').click()
  await page.getByRole('button',{name:'编辑日程',exact:true}).click()
  assert.equal(await end.inputValue(),'2030-01-02 02:20')
  await choose(start,'2030-01-02','03','00')
  assert.equal(await end.inputValue(),'2030-01-02 03:30')
  await page.screenshot({path:path.join(artifacts,`reopen-${width}.png`)})
  if(width>=1024){
   await start.click();await start.fill('2030-01-02 05:00');await start.press('Enter')
   const typedPopup=page.locator('.digital-calendar-date-popup:visible').last()
   await typedPopup.waitFor({state:'hidden'})
   await page.waitForFunction(()=>document.querySelector('[aria-label="结束时间"]')?.value==='2030-01-02 05:30')
   assert.equal(await end.inputValue(),'2030-01-02 05:30')
   // Clearing either time blocks submission and explains how to repair the range.
   await end.hover();await end.locator('..').locator('..').locator('.ant-picker-clear').click()
   assert.match(await editor.getByRole('alert').textContent(),/请选择有效的开始和结束时间/)
   assert.equal(await editor.getByRole('button',{name:'保存',exact:true}).isDisabled(),true)
  }
  await page.evaluate(()=>document.documentElement.style.setProperty('--font-scale','1.2'))
  await page.screenshot({path:path.join(artifacts,`large-font-${width}.png`)})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  assert.deepEqual(errors,[])
  results.push({width,default30:true,startResets:true,manualEnd:true,crossDay:true,invalidRange:true,createReopen:true,editReopen:true,geometry})
  console.log(`Validated calendar range at ${width}px`)
  await page.close()
 }
}finally{await browser.close()}
await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify(results,null,2))
console.log(JSON.stringify(results))
