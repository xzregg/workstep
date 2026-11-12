// Render the settings component with real CSS and isolated fixture data; no app server.
import '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'
import DecisionModelSettings from '../src/pages/DecisionModelSettings.tsx'
import { decisionModelsApi } from '../src/api/decisionModels.ts'
const { chromium } = await import('../../desktop/node_modules/playwright-core/index.mjs')
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const { window } = installDomEnvironment()
useLocaleStore.setState({ locale: 'zh-CN' })
const resource = { stage:'idle', installed:false, path:'/demo/decision-models', error:'', downloaded_bytes:0 }
const models = ['model','english','typed-decisions','kev-0.8b-q8','kev-4b-q4','kev-9b-q4','d1-omni-600m-q8','d1-2b-q4','d1-3b-q4','d1-omni-2b-q8'].map((kind,index)=>({id:index?'fixture-'+index:'laya-multilingual',resource_kind:kind,name:'模型 '+index,description:'模型说明',size_bytes:800000000}))
decisionModelsApi.status = async () => ({ models, settings:{ mode:'managed', base_url:'', model:'', has_api_key:false }, environment:{ supported:true, reasons:[] }, resources:{ runtime:resource, ...Object.fromEntries(models.map(model=>[model.resource_kind,resource])) }, worker:'stopped' })
const root = createRoot(document.body.appendChild(document.createElement('div')))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-decision-modes-'))
try {
 await act(async () => root.render(React.createElement(I18nProvider,null,React.createElement(DecisionModelSettings))))
 const css = process.argv.includes('--built')
  ? fs.readdirSync(new URL('../dist/assets/',import.meta.url)).filter(file=>file.endsWith('.css')).map(file=>fs.readFileSync(new URL('../dist/assets/'+file,import.meta.url),'utf8')).join('\n')
  : ['index.css','mobile.css','pages/DecisionModelSettings.css'].map(file => fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8')).join('\n')
 for (const width of [320,390,1023,1280]) for (const font of ['default','extraLarge']) {
  const page = await browser.newPage({ viewport:{width,height:1000} })
  await page.setContent(`<html data-font-size="${font}"><style>${css}</style><div class="settings-content">${document.body.innerHTML}</div></html>`)
  assert.equal(await page.getByText('搜索可本地运行的决策模型',{exact:true}).count(),0)
  const list = page.locator('.decision-resource-list')
  assert.ok(await list.evaluate(element=>element.scrollHeight>element.clientHeight && element.clientHeight<=Math.min(520,innerHeight*.6)+1),'resource list is bounded and scrollable')
  await list.locator('button').last().focus()
  assert.ok(await list.evaluate(element=>element.scrollTop>0),'keyboard focus reveals the last model')
  const boxes = await page.locator('.decision-modes button').evaluateAll(elements => elements.map(element => {
   const box=element.getBoundingClientRect()
   const children=[element.querySelector('strong'),element.querySelector('small')].map(child=>child.getBoundingClientRect())
   return { left:box.left,right:box.right,top:box.top,bottom:box.bottom,height:box.height,overflow:element.scrollWidth>element.clientWidth,
    contained:children.every(child=>child.left>=box.left && child.right<=box.right+1 && child.top>=box.top && child.bottom<=box.bottom+1) }
  }))
  assert.equal(boxes.length,3)
  for (const box of boxes) {
   assert.equal(box.overflow,false,`${width}/${font}: text fits button width`)
   assert.ok(box.contained,`${width}/${font}: description stays inside button`)
   assert.ok(box.right<=width,`${width}/${font}: button fits viewport`)
  }
  if(width<=1023) for(let i=1;i<boxes.length;i++) {
   assert.equal(boxes[i].left,boxes[0].left,'mobile left edges align')
   assert.equal(boxes[i].right,boxes[0].right,'mobile right edges align')
   assert.ok(boxes[i].top>=boxes[i-1].bottom+7,'mobile options do not overlap')
  }
  await page.screenshot({path:path.join(directory,`${width}-${font}.png`)})
  await page.close();console.log(`${width}/${font}: aligned, contained`)
 }
 console.log('Screenshots: '+directory)
} finally { await act(async()=>root.unmount());await window.happyDOM.close();await browser.close() }
