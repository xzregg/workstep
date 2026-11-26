import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { build } from 'vite'
import { chromium } from '../../desktop/node_modules/playwright-core/index.mjs'

const root = path.resolve(import.meta.dirname, '..')
const output = path.resolve(root, '../../tmp/workflow-create/browser')
await fs.mkdir(output, {recursive:true})
await build({root,logLevel:'error',publicDir:false,build:{outDir:output,emptyOutDir:true,
  rolldownOptions:{input:path.join(root,'tests/fixtures/workflow-create/index.html')}}})
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const results = []
try {
  for (const width of [320,390,1023,1440]) {
    const page = await browser.newPage({viewport:{width,height:844}})
    const errors = []
    page.on('pageerror',error=>errors.push(error.message))
    await page.route('https://workflow.invalid/**', async route => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname.startsWith('/api/')) {
        if (pathname.includes('assistants')) return route.fulfill({json:{assistants:[{name:'workflow_gen',configured:{engine:'pydantic_ai'},resolved:{engine:'pydantic_ai'},available_engines:[]}]}})
        return route.fulfill({json:{templates:[],providers:[],skills:[],items:[],engines:[],roles:[]}})
      }
      const file = pathname === '/' ? path.join(output,'tests/fixtures/workflow-create/index.html') : path.join(output,pathname)
      try { return route.fulfill({body:await fs.readFile(file),contentType:pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html'}) }
      catch { return route.fulfill({status:404}) }
    })
    await page.goto('https://workflow.invalid/')
    const dialog = page.locator('.workflow-create-dialog')
    await dialog.waitFor()
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))) })
    const mobile = width<=1023
    if (mobile) {
      assert.equal(await page.getByRole('tab').count(),2)
      assert.equal(await page.locator('#workflow-create-assistant').isVisible(),false)
      await page.getByRole('tab',{name:'流程助手',exact:true}).click()
      assert.equal(await page.locator('#workflow-create-preview').isVisible(),false)
    }
    const composer = dialog.locator('textarea').last()
    await composer.fill('创建发布流程')
    if (mobile) {
      await page.getByRole('tab',{name:'流程预览',exact:true}).click()
      await page.getByRole('tab',{name:'流程助手',exact:true}).click()
      assert.equal(await composer.inputValue(),'创建发布流程')
    }
    const geometry = await dialog.evaluate(element=>{
      const rect=element.getBoundingClientRect()
      const assistant=element.querySelector('#workflow-create-assistant').getBoundingClientRect()
      return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,overflow:element.scrollWidth>element.clientWidth,assistantWidth:assistant.width}
    })
    assert.ok(geometry.left>=0 && geometry.right<=width && geometry.bottom<=845 && !geometry.overflow,JSON.stringify(geometry))
    if (mobile) assert.ok(geometry.assistantWidth>=width-4,JSON.stringify(geometry))
    await page.screenshot({animations:'disabled',path:path.join(output,`assistant-${width}.png`)})
    if (width===390) {
      await page.setViewportSize({width,height:510})
      await page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})
      const inputBounds=await composer.boundingBox()
      assert.ok(inputBounds && inputBounds.y>=0 && inputBounds.y+inputBounds.height<=510)
      await page.screenshot({animations:'disabled',path:path.join(output,'assistant-390-short.png')})
      await page.setViewportSize({width,height:844})
    }
    await dialog.locator('.chat-input-send').click()
    await dialog.getByRole('button',{name:'关闭',exact:true}).click()
    await page.locator('.confirm-dialog-panel').waitFor()
    await page.locator('.confirm-dialog-panel').getByRole('button',{name:'取消',exact:true}).click()
    assert.equal(await dialog.isVisible(),true)
    if (mobile) {
      await page.getByRole('tab',{name:'流程预览',exact:true}).click()
      await page.screenshot({animations:'disabled',path:path.join(output,`preview-${width}.png`)})
      await page.getByRole('tab',{name:'流程助手',exact:true}).click()
    } else {
      await dialog.locator('.workflow-create-assistant-toggle').click()
      assert.equal(await page.locator('#workflow-create-assistant').isVisible(),false)
      assert.equal(await page.locator('.confirm-dialog-panel').count(),0)
      await dialog.locator('.workflow-create-assistant-toggle').click()
    }
    // A pending submission cannot be abandoned before the accepted turn can be stopped.
    await dialog.getByRole('button',{name:'关闭',exact:true}).click()
    await page.locator('.confirm-dialog-confirm').click()
    assert.equal(await dialog.isVisible(),true)
    assert.deepEqual(await page.evaluate(()=>window.workflowCreateFixture.stops()),[])
    await page.evaluate(()=>window.workflowCreateFixture.failStop(true))
    await page.evaluate(()=>window.workflowCreateFixture.accept())
    await page.getByRole('alert').filter({hasText:'停止失败'}).waitFor()
    assert.equal(await dialog.isVisible(),true)
    await page.evaluate(()=>window.workflowCreateFixture.failStop(false))
    await dialog.getByRole('button',{name:'关闭',exact:true}).click()
    await page.locator('.confirm-dialog-confirm').click()
    await dialog.waitFor({state:'detached'})
    const stops = await page.evaluate(()=>window.workflowCreateFixture.stops())
    assert.equal(stops.length,2)
    assert.equal(stops[0],stops[1])
    // A completed conversation still needs discard confirmation.
    await page.getByRole('button',{name:'重新打开',exact:true}).click()
    if (mobile) await page.getByRole('tab',{name:'流程助手',exact:true}).click()
    await page.locator('.workflow-create-dialog textarea').last().fill('新的流程')
    await page.locator('.chat-input-send').click()
    await page.evaluate(()=>window.workflowCreateFixture.accept())
    await page.locator('.chat-input-stop-glyph').waitFor()
    await page.evaluate(()=>window.workflowCreateFixture.complete())
    await page.locator('.chat-input-stop-glyph').waitFor({state:'hidden'})
    await page.locator('.workflow-create-dialog').getByRole('button',{name:'关闭',exact:true}).click()
    await page.locator('.confirm-dialog-panel').waitFor()
    await page.locator('.confirm-dialog-panel').getByRole('button',{name:'取消',exact:true}).click()
    if (mobile) {
      await page.evaluate(()=>history.back())
      await page.locator('.confirm-dialog-panel').waitFor()
      await page.locator('.confirm-dialog-panel').getByRole('button',{name:'取消',exact:true}).click()
      assert.equal(await dialog.isVisible(),true)
    }
    assert.deepEqual(errors,[])
    results.push({width,geometry,tabDraftPreserved:mobile,pendingDiscard:true,stopFailureRetry:true,completedConversationGuard:true})
    await page.close()
  }
} finally { await browser.close() }
await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2))
console.log(JSON.stringify(results))
