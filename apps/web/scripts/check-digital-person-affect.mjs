import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'vite'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.resolve(root,'../../tmp/digital-person-affect')
await fs.mkdir(artifacts,{recursive:true})
const state={person_id:'demo',name:'演示用户',affinity:63,emotion:'happy',valence:35,arousal:30,updated_at:'2026-11-14T01:00:00Z',history:[{id:1,project_id:'demo',session_id:'main',source_ids:['u'],kind:'chat',delta:1,before_value:62,after_value:63,emotion:'happy',reason:'一起解决问题，并表达感谢。',at:'2026-11-14T01:00:00Z'}]}
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});const results=[]
try{for(const view of ['home','workspace']){
 const name=`digital-person-${view}`,out=path.join(artifacts,name)
 await build({root,logLevel:'error',publicDir:false,build:{outDir:out,emptyOutDir:true,rolldownOptions:{input:path.join(root,`tests/fixtures/${name}/index.html`)}}})
 const html=await fs.readFile(path.join(out,`tests/fixtures/${name}/index.html`))
 for(const [width,height]of [[320,700],[390,844],[1440,1024]]){
 const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.hostname!=='affect.invalid')return route.abort()
  if(url.pathname==='/api/digital-person/affect/people')return route.fulfill({json:{items:[state,{...state,person_id:'visitor',name:'访客'}]}})
  if(url.pathname==='/api/digital-person/affect')return route.fulfill({json:{state:url.searchParams.get('person_id')==='visitor'?{...state,person_id:'visitor',name:'访客',affinity:50,history:[]}:state}})
  if(url.pathname.startsWith('/api/'))return route.fulfill({json:{items:[],sessions:[],turns:[],bots:[]}})
  if(url.pathname==='/')return route.fulfill({body:html,contentType:'text/html'})
  const file=path.resolve(out,url.pathname.replace(/^\//,''));if(!file.startsWith(out+path.sep))return route.abort()
  try{return route.fulfill({body:await fs.readFile(file),contentType:{'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream'})}catch{return route.fulfill({status:404,body:''})}
 })
 await page.goto('https://affect.invalid/?view=card')
 if(view==='home'){
  await page.locator('canvas[data-avatar-pose]').waitFor()
  assert.equal(await page.locator('[data-affect-readonly],.digital-affect').count(),0)
  assert.doesNotMatch(await page.locator('.digital-home').textContent(),/好感度|只读|随相处积累/)
  await page.screenshot({path:path.join(artifacts,`home-${width}.png`)})
 }else{
  const panel=page.locator('[data-affect-readonly]');await panel.waitFor()
  assert.equal(await panel.locator('details,summary').count(),0)
  assert.doesNotMatch(await panel.textContent(),/只读|随相处积累/)
  await page.screenshot({path:path.join(artifacts,`workspace-${width}.png`),fullPage:true})
  await panel.getByRole('button',{name:'变化记录',exact:true}).click()
  await page.screenshot({path:path.join(artifacts,`workspace-history-${width}.png`),fullPage:true})
  await page.locator('[data-settings-tab=identity]').click();await page.locator('[name=relationship_style]').selectOption('tsundere');await page.locator('[name=relationship_preferences]').fill('重视尊重与守信，熟悉后接受善意调侃。')
  await page.screenshot({path:path.join(artifacts,`identity-${width}.png`),fullPage:true});await page.locator('.digital-person-form-actions button').click()
  const saved=await page.evaluate(()=>window.workspaceFixture.getProfile());assert.equal(saved.relationship_style,'tsundere');assert.match(saved.relationship_preferences,/守信/)
 }
 assert.deepEqual(errors,[]);results.push({width,height,view,readOnly:true,errors});await page.close()
 }
}await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))}finally{await browser.close()}
