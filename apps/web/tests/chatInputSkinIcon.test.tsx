import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import {I18nProvider} from '../src/i18n'
import {defaultSkin} from '../src/skins/contract'
import {previewSkin,cancelSkinPreview,restoreDefaultSkin} from '../src/skins/runtime'
test('icon preview changes the real shared input while send and stop retain their actions', async()=>{
 const {window}=installDomEnvironment(); restoreDefaultSkin()
 const root=createRoot(document.body.appendChild(document.createElement('div')))
 let sent=0, stopped=0
 const render=(running=false,stopping=false)=>root.render(<I18nProvider><ChatInput value={running ? '' : '测试消息'} onChange={()=>{}} onSend={()=>{sent++}} onStop={()=>{stopped++}} running={running} stopping={stopping}/></I18nProvider>)
 try {
  await act(async()=>render())
  assert.ok(document.querySelector('.chat-input-send svg path[d="M22 2 11 13"]'))
  await act(async()=>previewSkin({...defaultSkin(),manifest:{...defaultSkin().manifest,id:'send-test'},layout:{composerSendIcon:'arrow-up'}}))
  assert.ok(document.querySelector('.chat-input-send path[d="M12 19V5"]'))
  await act(async()=>document.querySelector<HTMLButtonElement>('.chat-input-send')!.click()); assert.equal(sent,1)
  await act(async()=>render(true)); assert.ok(document.querySelector('.chat-input-stop-glyph')); assert.equal(document.querySelector('.chat-input-send svg'),null)
  await act(async()=>document.querySelector<HTMLButtonElement>('.chat-input-send')!.click()); assert.equal(stopped,1)
  await act(async()=>render(true,true)); assert.ok(document.querySelector('.chat-input-send .task-status-spinner'))
  await act(async()=>{cancelSkinPreview(); render()}); assert.ok(document.querySelector('.chat-input-send svg path[d="M22 2 11 13"]'))
 } finally {await act(async()=>root.unmount());restoreDefaultSkin();await window.happyDOM.close()}
})
