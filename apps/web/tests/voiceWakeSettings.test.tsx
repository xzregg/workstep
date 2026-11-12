import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { voiceWakeApi } from '../src/api/digitalPerson'
import VoiceWakeSettings from '../src/components/digital-person/VoiceWakeSettings'

test('wake configuration saves drafts but never starts a microphone or claims listening', async () => {
  const { window } = installDomEnvironment(); useLocaleStore.setState({locale:'zh-CN'})
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  const original = {...voiceWakeApi}
  let saved:any, dirty=false, tested=0
  voiceWakeApi.get=async()=>({keyword:'你好小研',sensitivity:'balanced',available:false,listening:false})
  voiceWakeApi.save=async value=>{saved=value;return {...value,available:false,listening:false}}
  const render=()=>root.render(<I18nProvider><VoiceWakeSettings onDirtyChange={value=>{dirty=value}} onTest={()=>{tested++}} testDisabled={false} sample="你好，小舟！帮我检查任务" /></I18nProvider>)
  try {
    await act(async()=>render())
    assert.match(element.textContent!,/未监听/)
    assert.equal(element.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled,true)
    const input=element.querySelector('input')!
    await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,'你好小舟');input.dispatchEvent(new window.Event('input',{bubbles:true}))})
    assert.equal(dirty,true)
    await act(async()=>element.querySelector<HTMLButtonElement>('[data-save-wake]')!.click())
    assert.equal(saved.keyword,'你好小舟');assert.equal(dirty,false)
    assert.match(element.textContent!,/包含唤醒词/)
    await act(async()=>element.querySelector<HTMLButtonElement>('[data-test-wake]')!.click())
    assert.equal(tested,1)
    assert.match(element.textContent!,/未监听/)
  } finally {await act(async()=>root.unmount());Object.assign(voiceWakeApi,original);await window.happyDOM.close()}
})
