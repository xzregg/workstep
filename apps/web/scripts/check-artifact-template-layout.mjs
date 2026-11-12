// Real component/CSS layout checks using isolated data, without an app server.
import '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'
import NodeConfigPanel from '../src/components/NodeConfigPanel.tsx'
import TaskStepIoPanel from '../src/components/TaskStepIoPanel.tsx'
const { chromium } = await import('../../desktop/node_modules/playwright-core/index.mjs')
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const { window } = installDomEnvironment()
useLocaleStore.setState({ locale: 'zh-CN' })
const root = createRoot(document.body.appendChild(document.createElement('div')))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-artifact-template-'))
const outputs = [{ name:'登录功能实现说明',type:'md',template:'# 修改内容\n[最多 3 条]\n\n## 验证结果\n[一句话]' }, {name:'登录功能异常场景测试报告',type:'md'}]
const step = {key:'build',label:'实现功能',prompt:'',inputs:[{name:'需求文档',type:'md',outputs}],outputs}
const artifacts = [{name:outputs[0].name,logical_name:outputs[0].name,step_key:'build',round:1,path:'report.md',declared_output:true,output_port:0,artifact_type:'md',updated_at:'2026-11-12T06:30:00Z'}]
const css = ['index.css','mobile.css','components/ArtifactOutputsEditor.css','components/ArtifactTemplateDialog.css','components/ConfirmDialog.css'].map(file=>fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8')).join('\n')
try {
 await act(async()=>root.render(React.createElement(I18nProvider,null,
  React.createElement('div',{className:'fixture'},
   React.createElement('h3',null,'步骤编辑'),React.createElement(NodeConfigPanel,{node:{...step,nodeId:1,color:'#0071e3',engine:'',model:'',config:{}},engines:[],unavailableKeys:[],defaultExecutionEngine:'',enginesLoading:false,enginesError:'',onValidationChange:()=>{},onDraftChange:()=>{},onDirtyChange:()=>{},onSave:()=>{},onClose:()=>{},onRequestDelete:()=>{}}),
   React.createElement('h3',null,'任务产物'),React.createElement(TaskStepIoPanel,{currentStep:step,steps:[step],workflowConnections:[],artifacts,artifactInputSnapshots:[],canChat:false,locale:'zh-CN',onOpenArtifact:()=>{}})))))
 const snapshot=()=>'<div class="fixture"><h3>步骤编辑</h3>'+document.querySelector('.artifact-input-row').closest('.flow-node-config-section').outerHTML+'<h3>任务产物</h3>'+document.querySelector('.task-step-io').outerHTML+'</div>'+(document.querySelector('.artifact-template-overlay')?.outerHTML||'')
 const closed=snapshot()
 await act(async()=>document.querySelector('.artifact-template-button').click())
 const opened=snapshot()
 for(const width of [320,390,1023,1280]) for(const [mode,html] of [['closed',closed],['dialog',opened]]) {
  const page=await browser.newPage({viewport:{width,height:900}})
  await page.setContent(`<html><style>${css}\n.fixture{padding:16px;max-width:440px}h3{margin:16px 0}</style>${html}</html>`)
  if(mode==='closed') {
   assert.ok(await page.locator('body').evaluate(e=>e.scrollWidth<=innerWidth),`${width}: page fits`)
   const alignment=await page.evaluate(()=>{
    const parent=document.querySelector('.artifact-input-row'),child=document.querySelector('.artifact-output-row');
    const rect=(row,selector)=>row.querySelector(selector).getBoundingClientRect();
    return {indent:rect(child,':scope > input').left-rect(parent,':scope > input').left,
      suffix:Math.abs(rect(child,'.combobox').left-rect(parent,'.combobox').left),
      remove:Math.abs(rect(child,'.artifact-output-remove').left-rect(parent,'button').left),
      nameRight:Math.abs(rect(child,':scope > input').right-rect(parent,':scope > input').right)}
   })
   assert.ok(alignment.indent>=24,`${width}: child name is indented (${alignment.indent})`)
   assert.ok(alignment.suffix<1&&alignment.remove<1&&alignment.nameRight<1,`${width}: fields align ${JSON.stringify(alignment)}`)
   const boxes=await page.locator('.task-step-io-output-identity').evaluate(e=>{
    const name=e.querySelector('.task-step-io-name').getBoundingClientRect(),icon=e.querySelector('.artifact-template-button').getBoundingClientRect();
    return {gap:icon.left-name.right,center:Math.abs(icon.top+icon.height/2-name.top-name.height/2)}
   })
   assert.ok(boxes.gap<=8&&boxes.gap>=0,`${width}: icon hugs name`)
   assert.ok(boxes.center<2,`${width}: single row`)
   const row=await page.locator('.task-step-io-output').boundingBox()
   assert.ok(row.x+row.width<=width,`${width}: task row fits`)
  } else {
   const box=await page.locator('.artifact-template-dialog').boundingBox()
   assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=901,`${width}: dialog fits viewport`)
   const area=await page.locator('.artifact-template-dialog textarea').boundingBox()
   assert.ok(area.height>200,`${width}: editor uses available space`)
  }
  await page.screenshot({path:path.join(directory,`${width}-${mode}.png`)})
  await page.close();console.log(`${width}/${mode}: passed`)
 }
 console.log('Screenshots: '+directory)
} finally {await act(async()=>root.unmount());await window.happyDOM.close();await browser.close()}
