// Production settings in an isolated browser with synthetic data; no app server.
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),artifacts=path.resolve(root,'../../tmp/digital-person-documents'),out=path.join(artifacts,'browser')
await fs.mkdir(artifacts,{recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.resolve(root,'tests/fixtures/digital-person-workspace/index.html')}}})
const html=await fs.readFile(path.join(out,'tests/fixtures/digital-person-workspace/index.html'))
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']})
const results=[]
const navigationOnly=process.argv.includes('--navigation-only'),widthArgs=process.argv.slice(2).filter(arg=>arg!=='--navigation-only')
try{
 for(const width of (widthArgs.length?widthArgs.map(Number):[320,390,1023,1024,1280,1440,1470])){
  const page=await browser.newPage({viewport:{width,height:width===1470?720:1000},reducedMotion:'reduce'}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>{
   Object.defineProperty(screen,'orientation',{configurable:true,value:{type:innerHeight>=innerWidth?'portrait-primary':'landscape-primary'}})
   const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
   navigator.mediaDevices.getUserMedia=constraints=>{window.cameraConstraints=constraints;return capture(constraints)}
  })
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url())
   if(url.hostname!=='settings.invalid')return route.abort()
   if(url.pathname==='/api/digital-person/affect/people')return route.fulfill({json:{items:[{person_id:'demo',name:'演示用户'}]}})
   if(url.pathname==='/api/digital-person/affect')return route.fulfill({json:{state:{person_id:'demo',name:'演示用户',affinity:63,emotion:'happy',valence:35,arousal:30,updated_at:'2026-11-14T01:00:00Z',history:[]}}})
   if(url.pathname==='/api/digital-person/memory/view')return route.fulfill({json:{bounded:true,items:Array.from({length:50},(_,i)=>({id:`memory:${i}`,summary:`项目配置与协作记录 ${i+1}，包含对话原始依据。`.repeat(i===0?12:1),kind:'event',outcome:'observed',state:'source',interpretation:false,time:'2026-11-14T01:00:00Z',time_is_source:true,entities:[],relations:[],sources:[]}))}})
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{enabled:false,items:[],sessions:[],turns:[],pending_inserts:[],bots:[]}})
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html})
   const filename=path.resolve(out,decodeURIComponent(url.pathname).replace(/^\//,''))
   if(!filename.startsWith(out+path.sep))return route.abort()
   try{const body=await fs.readFile(filename);return route.fulfill({body,contentType:{'.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'}[path.extname(filename)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
  })
  await page.goto('https://settings.invalid/?view=settings')
  await page.locator('[data-settings-tab=identity]').click()
  assert.equal(await page.locator('.digital-person-documents .markdown-editor-root').count(),3)
  assert.equal(await page.locator('[name=relationship_preferences]').count(),0)
  const persona=page.locator('[data-document=persona] textarea'),duties=page.locator('[data-document=duties] textarea'),memory=page.locator('[data-document=memory] textarea')
  assert.match(await persona.inputValue(),/研发协作伙伴/)
  assert.match(await persona.inputValue(),/简洁、可靠/)
  await persona.fill((await persona.inputValue())+'\n\n## 我的补充\n保留我的手写要求。')
  await page.getByRole('button',{name:'研发伙伴',exact:true}).click()
  await page.getByRole('button',{name:'严谨',exact:true}).click()
  await page.getByRole('button',{name:'专业克制',exact:true}).click()
  assert.match(await persona.inputValue(),/保留我的手写要求/)
  assert.match(await persona.inputValue(),/研发伙伴/)
  await page.locator('[data-document=persona] .markdown-editor-action').first().click()
  assert.match(await page.locator('[data-document=persona] .markdown-editor-preview').innerText(),/保留我的手写要求/)
  await page.locator('[data-document=persona] .markdown-editor-action').first().click()
  await page.screenshot({path:path.join(artifacts,`documents-top-${width}.png`),animations:'disabled'})
  await page.getByRole('button',{name:'说明不确定性',exact:true}).click()
  assert.match(await memory.inputValue(),/信息不确定时/)
  await memory.fill((await memory.inputValue())+'\n- 我自己填写的长期约定。')
  await memory.scrollIntoViewIfNeeded()
  await page.screenshot({path:path.join(artifacts,`documents-memory-${width}.png`),animations:'disabled'})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.locator('.digital-person-form-actions button').click()
  const saved=await page.evaluate(()=>window.workspaceFixture.getProfile())
  assert.match(saved.persona_markdown,/保留我的手写要求/)
  assert.match(saved.conversation_rules,/我自己填写的长期约定/)
  assert.match(saved.duties,/澄清需求/)
  assert.deepEqual(errors,[]);results.push({width,passed:true,editors:3,presetAndManualEditsSaved:true});await page.close()
 }
 console.log(JSON.stringify(results));await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify(results,null,2))
}finally{await browser.close()}
