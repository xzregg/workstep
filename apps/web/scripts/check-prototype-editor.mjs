import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({executablePath:process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
try {
  const page = await browser.newPage({viewport:{width:1200,height:800}})
  const script = (await fs.readFile('../daemon/data/prototype-editor.js','utf8')).replace('__WS_VERSION__',JSON.stringify('test-version'))
  const source = '<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src &#39;nonce-testnonce&#39;"><script>parent.postMessage({source:"workstep-prototype",type:"forged"},"*")</script><html><body><div style="padding:40px"><button data-ws-node="n1" style="width:100px;height:50px">First</button><button data-ws-node="n2" style="width:100px;height:50px">Second</button><p data-ws-node="n3">Editable</p></div></body></html>'
  await page.setContent('<iframe sandbox="allow-scripts" style="width:900px;height:600px"></iframe>')
  await page.evaluate(content=>{
    window.messages=[]
    window.addEventListener('message',event=>{if(event.data?.source==='workstep-prototype')window.messages.push(event.data)})
    document.querySelector('iframe').srcdoc=content
  },source+'<script nonce="testnonce">'+script+'</script>')
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='ready'))
  await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({source:'workstep-prototype-host',type:'mode',enabled:true},'*'))
  assert.equal(await page.evaluate(()=>window.messages.some(m=>m.type==='forged')),false,'page scripts cannot forge edit operations')
  const frame = page.frameLocator('iframe')
  await frame.getByText('Second',{exact:true}).click()
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='select'&&m.selection.node_id==='n2'))
  await frame.getByText('First',{exact:true}).click({button:'right'})
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='select'&&m.comment&&m.selection.node_id==='n1'))
  await frame.getByText('Editable',{exact:true}).dblclick()
  await frame.locator('p').fill('Changed')
  await frame.locator('p').press('Tab')
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='edit'&&m.operation==='text'&&m.values.text==='Changed'))
  assert.equal(await frame.locator('p').textContent(),'Editable','bridge emits an operation instead of saving DOM')
  await frame.getByText('Second',{exact:true}).click()
  const box = await frame.getByText('Second',{exact:true}).boundingBox()
  await page.screenshot({path:'/tmp/prototype-bridge.png'})
  await page.mouse.move(box.x+box.width,box.y+box.height/2)
  await page.mouse.down();await page.mouse.move(box.x+box.width+50,box.y+box.height/2,{steps:8});await page.mouse.up()
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='edit'&&m.operation==='style'),{},{timeout:3000})
  const edits=await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))
  assert.equal(edits.at(-1).node_id,'n2')
  assert.equal(edits.at(-1).values.width,'150px')
  await page.keyboard.press('Delete')
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='delete-request'&&m.selection.node_id==='n2'))
  process.stdout.write('Prototype bridge: selection, right-click, text, resize and delete passed.\n')
} finally {await browser.close()}
