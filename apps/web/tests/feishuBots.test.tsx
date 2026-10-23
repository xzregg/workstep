import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import BotSettingsEditor from '../src/components/BotSettingsEditor'
import ChatSessionSourceBadge from '../src/components/ChatSessionSourceBadge'
import { useProjectStore } from '../src/stores/projectStore'

test('Feishu and Lark bots use App ID credentials and preserve their platform when saved', async () => {
 for (const platform of ['feishu', 'lark']) {
  const { window } = installDomEnvironment()
  const previousFetch = globalThis.fetch, previousStore = useProjectStore.getState()
  useLocaleStore.setState({locale:'zh-CN'})
  useProjectStore.setState({projects:[{id:'p',name:'演示',type:'local'}] as any, fetchProjects:async()=>{}})
  let saved: any
  globalThis.fetch = async (_input, init) => {
   if (init?.method === 'POST') saved = JSON.parse(String(init.body))
   return Response.json(init?.method === 'POST' ? {...saved,id:'bot'} : [])
  }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  try {
   await act(async()=>root.render(<I18nProvider><BotSettingsEditor platform={platform as 'feishu' | 'lark'} onPlatformChange={()=>{}} onSaved={()=>{}} onCancel={()=>{}} onDirtyChange={()=>{}} onBusyChange={()=>{}}/><ChatSessionSourceBadge source="channel" platform={platform} conversationType="group"/></I18nProvider>))
   const selects = container.querySelectorAll<HTMLSelectElement>('select')
   assert.ok(selects[0].querySelector(`option[value="${platform}"]`))
   assert.match(container.querySelector('.bot-settings-form')!.textContent!, /App ID/)
   assert.match(container.querySelector('.chat-session-source-badge')!.textContent!, platform==='feishu'?/飞书/:/Lark/)
   assert.ok(container.querySelector(`a[href="https://${platform==='feishu'?'open.feishu.cn':'open.larksuite.com'}/app"]`))
   const fields = container.querySelectorAll<HTMLInputElement>('.bot-settings-form input:not([type="checkbox"])')
   for (const [index,value] of ['助手','cli_app','secret'].entries()) await act(async()=>{
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(fields[index],value)
    fields[index].dispatchEvent(new window.Event('input',{bubbles:true}))
   })
   await act(async()=>{selects[1].value='p';selects[1].dispatchEvent(new window.Event('change',{bubbles:true}))})
   await act(async()=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='保存')!.click())
   assert.equal(saved.platform,platform);assert.equal(saved.app_id,'cli_app');assert.equal(saved.default_project_id,'p')
   assert.equal(saved.card_template_id,undefined)
  } finally {
   await act(async()=>root.unmount());container.remove();globalThis.fetch=previousFetch;useProjectStore.setState(previousStore);await window.happyDOM.close()
  }
 }
})
