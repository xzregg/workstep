// Offline rendering of real React components. No daemon or app server is started.
import '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../src/i18n/index.tsx'
import {installDomEnvironment} from '../tests/helpers/domEnv.ts'
import AssistantChatPanel from '../src/components/AssistantChatPanel.tsx'
import DigitalPersonFeedback from '../src/components/digital-person/DigitalPersonFeedback.tsx'
import DigitalPersonCompanion from '../src/components/digital-person/DigitalPersonCompanion.tsx'
import {speechApi} from '../src/api/speech.ts'
import DigitalPersonSettings from '../src/components/digital-person/DigitalPersonSettings.tsx'
import {digitalPersonApi,digitalRuntimeApi} from '../src/api/digitalPerson.ts'
import {assistantApi,providerApi} from '../src/api/client.ts'
const {chromium}=await import('../../desktop/node_modules/playwright-core/index.mjs')
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const output = new URL('../../../tmp/digital-person-design/',import.meta.url)
fs.mkdirSync(output,{recursive:true})
const assets=new URL('../dist/assets/',import.meta.url)
const stylesheet=fs.readdirSync(assets).find(name=>/^index-.*\.css$/.test(name))
assert.ok(stylesheet,'run yarn build before the layout check')
const css=fs.readFileSync(new URL(stylesheet,assets),'utf8')
speechApi.status=async()=>({enabled:false})
digitalRuntimeApi.feedback=async()=>({})
digitalPersonApi.get=async()=>({enabled:true,onboarding_completed:true,name:'小研',role:'研发伙伴',personality:'简洁、可靠',duties:'理解需求、指派任务、跟进结果',avatar:'robot',greeting:'今天有什么需要我处理？'})
digitalRuntimeApi.activity=async()=>({level:3,experience:45,next_level_experience:90,feedback:{},suggestions:[],answers:[],delegations:[],runs:[]})
digitalRuntimeApi.channels=async()=>({available:[],bindings:[{session_id:'demo',project_id:'demo',bot_id:'demo',title:'操作手册演示渠道',bot_name:'演示机器人',platform:'demo',notify:true}]})
assistantApi.list=async()=>({assistants:[{name:'digital_person',fields:['engine'],configured:{},resolved:{},available_engines:[]}]})
providerApi.list=async()=>({providers:[]})
try{
 for(const width of [320,390,1023,1440]){
  const {window,document}=installDomEnvironment();window.happyDOM.setWindowSize({width,height:900});useLocaleStore.setState({locale:'zh-CN'})
  const root=createRoot(document.body.appendChild(document.createElement('div')))
  await act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(I18nProvider,null,React.createElement(DigitalPersonSettings,{onClose(){}})))))
  const page=await browser.newPage({viewport:{width,height:900}})
  for(const tab of ['card','identity','appearance','proactive','channels','activity']){
   await act(async()=>document.getElementById('digital-person-tab-'+tab).click())
   await page.setContent(`<style>${css}</style><div class="settings-content">${document.body.innerHTML}</div>`)
   const header=await page.locator('.digital-person-header').boundingBox()
   assert.ok(header.x>=0 && header.x+header.width<=width+1,`${width}/${tab}: header fits`)
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)
   assert.equal(overflow,false,`${width}/${tab}: no page horizontal overflow`)
   for(const selector of ['.digital-person-header [role=switch]',...(tab==='card'?['.digital-person-avatar']:[])]){
    const box=await page.locator(selector).boundingBox();assert.ok(box.x>=0 && box.x+box.width<=width+1,`${width}/${tab}/${selector}`)
   }
   await page.screenshot({path:new URL(`settings-${width}-${tab}.png`,output).pathname,fullPage:true})
  }
  console.log(`${width}: six configuration screens fit`)
  const profile=await digitalPersonApi.get()
  const noop=()=>{}
  const config={engines:[],engine:'codex',defaultEngine:'codex',model:'gpt-6',fastModel:'',onEngineChange:noop,onModelChange:noop,onFastModelChange:noop}
  const copy={emptyIntro:'今天有什么需要一起推进的？',thinking:'思考中',me:'我',meInitials:'我',agent:'小研',agentInitials:'研',placeholder:'输入消息…',fullPrompt:'提示词',closePrompt:'关闭'}
  const messages=[{id:'u',role:'user',content:'你是谁？',status:'completed',events:[],created_at:'2026-11-12T14:50:40Z'},{id:'a',role:'assistant',content:'我是小研，你的研发伙伴。可以帮你梳理需求、安排任务，并跟进处理结果。',status:'completed',engine:'codex',model:'gpt-6',events:[],created_at:'2026-11-12T14:50:40Z'}]
  await act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(I18nProvider,null,React.createElement(AssistantChatPanel,{
    projectId:'demo',sessionId:'demo',title:'小研',messages,running:false,stopping:false,input:'',copy,locale:'zh-CN',config,attachmentPrefix:'demo',onInputChange:noop,onSend:noop,onSendContent:async()=>true,onStop:noop,
    headerTitle:width>1023?React.createElement(DigitalPersonCompanion,{profile,inline:true,replyId:'a',reply:messages[1].content}):undefined,
    headerContext:width<=1023?React.createElement(DigitalPersonCompanion,{profile,replyId:'a',reply:messages[1].content}):undefined,
    renderMessageActions:id=>React.createElement(DigitalPersonFeedback,{messageId:id}),
  })))))
  await act(async()=>document.querySelector('[aria-label="有帮助"]').click())
  assert.equal(document.querySelector('[aria-label="有帮助"]').getAttribute('aria-pressed'),'true')
  await page.setContent(`<style>${css}html,body{height:100%;margin:0}.assistant-chat-panel{height:100dvh;min-height:0}.digital-person-companion{flex-shrink:0}</style>${document.body.innerHTML}`)
  const companion=await page.locator('.digital-person-companion').boundingBox()
  assert.ok(companion.height<=56,`${width}: identity stays one compact row`)
  assert.equal(await page.locator('.digital-person-companion button').count(),0,'unsupported voice has no dead button')
  for(const selector of ['.digital-person-feedback','.message-response-footer','.digital-person-companion']){
    const box=await page.locator(selector).boundingBox();assert.ok(box.x>=0 && box.x+box.width<=width+1,`${width}/${selector} fits`)
  }
  await page.screenshot({path:new URL(`chat-${width}.png`,output).pathname,fullPage:true})
  console.log(`${width}: chat feedback toggled; toolbar and identity fit`)

  await page.close();await act(async()=>root.unmount());await window.happyDOM.close()
 }
}finally{await browser.close()}
