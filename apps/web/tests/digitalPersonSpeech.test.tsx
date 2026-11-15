import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import DigitalPersonSpeech from '../src/components/digital-person/DigitalPersonSpeech'
import type { AssistantChatMessage } from '../src/stores/assistantStore'
import { speechOutputApi } from '../src/api/speechOutput'
import { SpeechOutputPlayer } from '../src/utils/speechOutput'
import { outputStatus } from './fixtures/speechOutput'

test('digital person only speaks new running sentences once, flushes tail and suppresses history replay', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const oldStatus = speechOutputApi.status, oldEnqueue = SpeechOutputPlayer.prototype.enqueue, oldStop = SpeechOutputPlayer.prototype.stop
  const spoken: string[] = []
  let stops = 0
  speechOutputApi.status = async () => structuredClone(outputStatus)
  SpeechOutputPlayer.prototype.enqueue = function (sentences) { spoken.push(...sentences) }
  SpeechOutputPlayer.prototype.stop = function () { stops++ }
  const profile = { enabled: true, name: '测试助手', role: '', personality: '', duties: '', avatar: 'robot' as const, greeting: '', auto_speak: true }
  const render = async (messages: AssistantChatMessage[], sessionId = 'session', muted = false) => act(async () => root.render(
    <I18nProvider><DigitalPersonSpeech profile={profile} projectId="project" sessionId={sessionId} messages={messages} active muted={muted} /></I18nProvider>))
  const message = (id: string, content: string, status: AssistantChatMessage['status']): AssistantChatMessage => ({ id, role: 'assistant', content, status })
  try {
    await render([message('old', '历史回复。', 'succeeded')])
    assert.deepEqual(spoken, [])
    await render([message('new', '第一句。第二', 'running')])
    assert.deepEqual(spoken, ['第一句。'])
    await render([message('new', '第一句。第二句！尾巴', 'running')])
    assert.deepEqual(spoken, ['第一句。', '第二句！'])
    await render([message('new', '第一句。第二句！尾巴', 'succeeded')])
    assert.deepEqual(spoken, ['第一句。', '第二句！', '尾巴'])
    await render([message('new', '第一句。第二句！尾巴', 'succeeded')])
    assert.equal(spoken.length, 3)
    await render([message('another', '其他会话历史。', 'succeeded')], 'another-session')
    assert.equal(spoken.length, 3)
    await render([message('muted', '静音期间第一句。', 'running')], 'session', true)
    await render([message('muted', '静音期间第一句。第二句。', 'running')], 'session', true)
    assert.equal(spoken.length, 3)
    await render([message('muted', '静音期间第一句。第二句。', 'running')])
    assert.equal(spoken.length, 3, 'unmuting never replays the muted reply')
    await render([message('audible', '新回复。', 'running')])
    assert.deepEqual(spoken, ['第一句。', '第二句！', '尾巴', '新回复。'])
    const beforeMute = stops
    await render([message('audible', '新回复。后续句。', 'running')], 'session', true)
    assert.ok(stops > beforeMute, 'muting stops the current player immediately')
    assert.equal(spoken.length, 4)
    await render([{...message('proactive', '主动通知。', 'running'),proactive:true}])
    assert.equal(spoken.length,4,'global proactive player owns this message; no second voice')
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    speechOutputApi.status = oldStatus; SpeechOutputPlayer.prototype.enqueue = oldEnqueue; SpeechOutputPlayer.prototype.stop = oldStop
  }
})


test('synthesis preparation emits a scoped busy state even before audio starts',async()=>{
 const {DIGITAL_OUTPUT_FRAME}=await import('../src/components/digital-person/digitalPersonVoiceEvents')
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 const original={...speechOutputApi},frames:any[]=[];let ready!:(value:{id:string})=>void
 speechOutputApi.status=async()=>({...structuredClone(outputStatus),settings:{...outputStatus.settings,mode:'remote'}})
 speechOutputApi.start=()=>new Promise(resolve=>{ready=resolve})
 speechOutputApi.next=async()=>({done:true})
 speechOutputApi.cancel=async()=>{}
 window.addEventListener(DIGITAL_OUTPUT_FRAME,(event:Event)=>frames.push((event as CustomEvent).detail))
 const profile={enabled:true,name:'助手',role:'',personality:'',duties:'',avatar:'robot' as const,greeting:'',auto_speak:true}
 const render=(messages:AssistantChatMessage[])=>act(async()=>root.render(<DigitalPersonSpeech profile={profile} projectId="synthesis-gap" sessionId="s" messages={messages} active/>))
 try{
  await render([])
  await render([{id:'new',role:'assistant',content:'第一句话。',status:'running'}])
  assert.ok(frames.some(frame=>frame.busy&&!frame.playing&&frame.projectId==='synthesis-gap'))
  await act(async()=>ready({id:'audio'}))
  assert.equal(frames.at(-1).busy,false)
 }finally{await act(async()=>root.unmount());Object.assign(speechOutputApi,original);await window.happyDOM.close()}
})
