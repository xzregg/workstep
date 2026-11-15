// Authorized isolated Chromium check. No app server, real model or real user data.
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
const out=path.resolve(root,'../../tmp/digital-person-jarvis/browser')
const artifacts=path.dirname(out)
await fs.mkdir(artifacts,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.resolve(root,'tests/fixtures/digital-person-workspace/index.html')}}})
const html=await fs.readFile(path.join(out,'tests/fixtures/digital-person-workspace/index.html'))
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const results=[]
try{
 for(const width of [320,390,768,1023,1280,1470]){
  const context=await browser.newContext({viewport:{width,height:959},deviceScaleFactor:1,reducedMotion:'reduce'})
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url())
   if(url.hostname!=='workstep-ui.invalid')return route.abort()
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{enabled:false,items:[],sessions:[],turns:[],pending_inserts:[]}})
   if(url.pathname==='/' || url.pathname==='/chat')return route.fulfill({contentType:'text/html',body:html})
   const relative=decodeURIComponent(url.pathname).replace(/^\//,'')
   const base=out
   const filename=path.resolve(base,relative)
   if(!filename.startsWith(base+path.sep))return route.abort()
   try{
    const body=await fs.readFile(filename)
    const ext=path.extname(filename),type={'.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.json':'application/json'}[ext] || 'application/octet-stream'
    return route.fulfill({contentType:type,body})
   }catch{return route.fulfill({status:404,body:'not found'})}
  })
  const page=await context.newPage(),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
  await page.goto('https://workstep-ui.invalid/')
  await page.locator('.digital-person-workspace').waitFor()
  await page.locator('.digital-console-core').first().evaluate(img=>img.decode())
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.digital-person-workspace')).getPropertyValue('--bg').trim()),await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()),'workspace inherits app theme')
  if(width<=1023)assert.equal(await page.getByRole('button',{name:'运行记录',exact:true}).count(),1,'one runtime entry')
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}: no horizontal page overflow`)
  const screenshot=path.join(artifacts,`workspace-${width}.png`)
  await page.screenshot({animations:'disabled',path:screenshot,fullPage:true})
  const wakeBounds=await page.locator('[data-console-listen]').boundingBox()
  assert.ok(wakeBounds && wakeBounds.y<80,'voice wake is at the top')
  assert.equal(await page.locator('.digital-console-command-bar').count(),0,'no bottom toolbar')
  const coreUrl=await page.locator('.digital-console-core').first().getAttribute('src')
  assert.match(coreUrl,/assets\/digital-person-cognition-.*\.png$/,'image is a bundled build asset')
  if([390,1470].includes(width)){
   await page.emulateMedia({colorScheme:'dark'})
   assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.digital-person-workspace')).getPropertyValue('--bg').trim()),await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()),'dark theme inherited')
   await page.screenshot({animations:'disabled',path:path.join(artifacts,`workspace-${width}-dark.png`),fullPage:true})
   await page.emulateMedia({colorScheme:'light'})
  }
  const composer=await page.locator('.chat-composer-outer').boundingBox()
  assert.ok(composer && composer.y+composer.height<=960,`${width}: composer stays in viewport`)
  if(width<=1023){
   await page.getByRole('button',{name:'运行记录',exact:true}).first().click()
   await page.getByRole('dialog',{name:'运行记录'}).waitFor()
   const dialog=await page.getByRole('dialog').boundingBox()
   assert.ok(dialog.x>=0 && dialog.x+dialog.width<=width+1,`${width}: drawer fits`)
   await page.getByRole('dialog').locator('[data-console-check]').click()
   await page.getByRole('dialog').getByText('当前任务仍在执行，无需通知。').waitFor({state:'attached'})
   await page.screenshot({animations:'disabled',path:path.join(artifacts,`drawer-${width}.png`),fullPage:true})
   await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
   await page.getByRole('dialog').waitFor({state:'detached'})
  }else{
   await page.locator('[data-console-check]').click()
   await page.getByRole('status').filter({hasText:'检查完成，无需打扰'}).waitFor()
  }
  const vote=page.getByRole('button',{name:'有帮助',exact:true}).first()
  await vote.click();assert.equal(await vote.getAttribute('aria-pressed'),'true')
  await vote.click();assert.equal(await vote.getAttribute('aria-pressed'),'false')
  assert.equal(await page.evaluate(()=>window.workspaceFixture.calls.voice),0,'mount must not request microphone')
  await page.locator('[data-console-listen]').click()
  assert.equal(await page.evaluate(()=>window.workspaceFixture.calls.voice),1)
  await page.evaluate(()=>window.workspaceFixture.setPhase('recording'))
  await page.locator('[data-state=listening]').waitFor()
  await page.locator('[data-console-listen]').click()
  const input=page.locator('textarea').first()
  await input.fill('请继续跟进构建异常。')
  await page.locator('.chat-input-send').click()
  await page.getByText('收到。我会先确认当前进展，再把需要处理的工作交给对应项目。',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>window.workspaceFixture.calls.check),1)
  if(width<=1023)await page.getByRole('button',{name:'运行记录',exact:true}).first().click()
  await page.getByRole('button',{name:/排查构建异常并验证修复结果/}).click()
  assert.match(page.url(),/session=worker-1/)

  await page.goto('https://workstep-ui.invalid/?view=card')
  await page.locator('.digital-person-stat-counts').waitFor()
  assert.deepEqual(await page.locator('.digital-person-stat-counts dd').allTextContents(),['12','44','8','5'])
  await page.locator('.digital-person-stat-skills summary').click()
  await page.getByText('代码评审',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>window.workspaceFixture.calls.activity),1,'one namecard data request')
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'namecard does not overflow')
  await page.screenshot({animations:'disabled',path:path.join(artifacts,`namecard-${width}.png`),fullPage:true})
  await page.locator('.digital-person-secondary-nav [data-settings-tab=identity]').click()
  await page.getByRole('group',{name:'身份预设'}).getByRole('button',{name:'研发伙伴',exact:true}).click()
  await page.getByRole('group',{name:'身份预设'}).getByRole('button',{name:'项目管家',exact:true}).click()
  await page.locator('[name=role]').fill('研发伙伴、项目管家、质量伙伴')
  await page.getByRole('group',{name:'性格预设'}).getByRole('button',{name:'耐心',exact:true}).click()
  await page.getByRole('group',{name:'语气预设'}).getByRole('button',{name:'专业克制',exact:true}).click()
  await page.getByRole('group',{name:'语气预设'}).getByRole('button',{name:'温和亲切',exact:true}).click()
  await page.locator('[name=tone]').fill('专业克制、温和亲切、自定义语气')
  assert.equal(await page.getByRole('group',{name:'语气预设'}).getByRole('button',{name:'温和亲切',exact:true}).getAttribute('aria-pressed'),'true','free text preserves selected tone presets')
  await page.locator('.fixture-namecard').evaluate(el=>el.scrollTop=0)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'trait presets do not overflow')
  await page.screenshot({animations:'disabled',path:path.join(artifacts,`identity-traits-${width}.png`),fullPage:true})
  await page.getByRole('button',{name:'保存',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.workspaceFixture.getProfile().tone),'专业克制、温和亲切、自定义语气')
  assert.equal(await page.evaluate(()=>window.workspaceFixture.getProfile().role),'研发伙伴、项目管家、质量伙伴')
  await page.getByRole('button',{name:'编辑档案',exact:true}).click()
  assert.equal(await page.locator('[name=tone]').inputValue(),'专业克制、温和亲切、自定义语气')
  assert.deepEqual(errors,[],`${width}: no browser console or runtime errors`)
  results.push({width,overflow:false,composerVisible:true,feedback:true,manualCheck:true,explicitVoiceToggle:true,send:true,namecardStats:true,traitPresets:true,errors,screenshot})
  console.log(`${width}: layout, drawer, check, feedback, voice toggle and send passed`)
  await context.close()
 }
 await fs.writeFile(path.join(artifacts,'browser-results.json'),JSON.stringify(results,null,2))
}finally{await browser.close()}
