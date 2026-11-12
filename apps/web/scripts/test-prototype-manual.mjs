// Fixed manual demo only. Real UI + real file APIs; no paid model invocation.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import {chromium} from '../../desktop/node_modules/playwright-core/index.mjs'
const demoProject=os.homedir()+'/.workstep-manual-demo/projects/storage-demo'
const root=demoProject+'/prototype-editor-demo'
const catalog=await (await fetch('http://127.0.0.1:8777/api/project/list')).json()
const project=catalog.projects.find(item=>item.path===demoProject&&item.name==='操作手册演示')?.id
assert.ok(project,'fixed manual demo project must be registered')
await fs.mkdir(root,{recursive:true})
for(const name of ['index.html','detail.html','common.css']) await fs.copyFile(new URL('./fixtures/prototype-manual/'+name,import.meta.url),root+'/'+name)
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1})
let commentRequest
await page.route('**/api/prototype/*/chat?*', async route=>{
 commentRequest=route.request().postDataJSON()
 await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'模拟连接失败，请重试'})})
})
try {
 await page.goto('http://127.0.0.1:8777')
 await page.getByText('使用者名称',{exact:true}).waitFor()
 await page.locator('input').filter({visible:true}).last().fill('演示用户')
 await page.getByRole('button',{name:'直接进入',exact:true}).click()
 await page.goto('http://127.0.0.1:8777/file-preview?'+new URLSearchParams({project_id:project,path:'prototype-editor-demo/index.html'}))
 await page.getByRole('button',{name:'原型编辑',exact:true}).click()
 await page.locator('.prototype-editor').waitFor()
 const frame=page.frameLocator('.prototype-frame-wrap iframe')
 const select=async()=>{await frame.getByRole('button',{name:'查看项目',exact:true}).nth(1).click()}
 await select()
 const field=page.locator('.prototype-properties textarea')
 await field.fill('查看详情')
 await field.press('Tab')
 await frame.getByRole('button',{name:'查看详情',exact:true}).waitFor()
 let source=await fs.readFile(root+'/index.html','utf8')
 assert.match(source,/>查看项目<\/button>/)
 assert.match(source,/>查看详情<\/button>/)
 assert.ok(!source.includes('data-ws-node'),'editor markers stay out of source')
 await frame.getByRole('button',{name:'查看详情',exact:true}).click()
 const width=page.getByRole('textbox',{name:'width',exact:true})
 await width.fill('180px');await width.press('Tab')
 await page.waitForFunction(()=>!document.querySelector('.prototype-status--busy'))
 await page.waitForTimeout(300)
 assert.match(await fs.readFile(root+'/index.html','utf8'),/width: 180px/)
 await frame.getByText('可删除的演示说明',{exact:true}).click()
 await page.getByRole('button',{name:'删除选中元素',exact:true}).click()
 await page.locator('.confirm-dialog-confirm').click()
 await frame.getByText('可删除的演示说明',{exact:true}).waitFor({state:'detached'})
 assert.ok(!(await fs.readFile(root+'/index.html','utf8')).includes('可删除的演示说明'))
 await page.getByRole('button',{name:'撤销',exact:true}).click()
 await frame.getByText('可删除的演示说明',{exact:true}).waitFor()
 await page.getByRole('button',{name:'index.html',exact:true}).click()
 await page.getByRole('button',{name:'detail.html',exact:true}).click()
 await frame.getByRole('heading',{name:'项目详情',exact:true}).waitFor()
 await page.getByRole('button',{name:'detail.html',exact:true}).click()
 await page.getByRole('button',{name:'index.html',exact:true}).click()
 await frame.getByRole('button',{name:'查看详情',exact:true}).click({button:'right'})
 await page.locator('.prototype-comment textarea').fill('将这个按钮改成绿色，保留旁边按钮的样式。')
 // Screenshot contains real UI and an unsent draft, never simulated results.
 await page.screenshot({path:'../landing/src/manual/screenshots/prototype-editor.jpg',type:'jpeg',quality:88})
 const divider=page.locator('.prototype-divider').first()
 const dividerBox=await divider.boundingBox()
 const before=await page.locator('.prototype-chat').boundingBox()
 await page.mouse.move(dividerBox.x+2,dividerBox.y+100);await page.mouse.down();await page.mouse.move(dividerBox.x+42,dividerBox.y+100,{steps:6});await page.mouse.up()
 assert.ok((await page.locator('.prototype-chat').boundingBox()).width>before.width+20,'divider resizes real chat pane')
 const handle=page.locator('.prototype-editor>.resizable-panel-e')
 const handleBox=await handle.boundingBox()
 const beforeWindow=await page.locator('.prototype-editor').boundingBox()
 await page.mouse.move(handleBox.x+2,handleBox.y+100);await page.mouse.down();await page.mouse.move(handleBox.x-50,handleBox.y+100,{steps:6});await page.mouse.up()
 assert.ok((await page.locator('.prototype-editor').boundingBox()).width<beforeWindow.width-20,'modal edge resizes real window')
 await page.getByRole('button',{name:'发送到聊天',exact:true}).click()
 await page.getByText('模拟连接失败，请重试',{exact:false}).waitFor()
 assert.equal(commentRequest.selection.tag,'button')
 assert.equal(commentRequest.selection.text,'查看详情')
 assert.ok(commentRequest.selection.node_id)
 assert.equal(await page.locator('.prototype-comment textarea').inputValue(),'将这个按钮改成绿色，保留旁边按钮的样式。')
 console.log('PASS: exact selection, source text/style writeback, delete/undo, sibling switch, divider/window resizing, comment target and retry draft; screenshot captured from 8777.')
} catch(error) {
 console.error((await page.locator('body').innerText()).slice(-6000))
 await page.screenshot({path:'/tmp/prototype-manual-failure.png'})
 throw error
} finally {await browser.close()}
