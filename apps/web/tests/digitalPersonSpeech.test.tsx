import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import DigitalPersonSpeech, {type DigitalPersonSpeechControls} from '../src/components/digital-person/DigitalPersonSpeech'
import {DIGITAL_OUTPUT_FRAME,stopDigitalSpeech,type DigitalOutputFrame} from '../src/components/digital-person/digitalPersonVoiceEvents'
import type { AssistantChatMessage } from '../src/stores/assistantStore'
import { speechOutputApi } from '../src/api/speechOutput'
import { SpeechOutputPlayer } from '../src/utils/speechOutput'
import { outputStatus } from './fixtures/speechOutput'

test('explicit reading replaces auto speech, blocks capture during preparation and can be stopped', async () => {
  const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
  const controls=createRef<DigitalPersonSpeechControls>(),frames:DigitalOutputFrame[]=[],spoken:string[]=[]
  const {status}=speechOutputApi,{unlock,enqueue,stop}=SpeechOutputPlayer.prototype
  let finishUnlock!:()=>void,stops=0
  speechOutputApi.status=async()=>structuredClone(outputStatus)
  SpeechOutputPlayer.prototype.unlock=()=>new Promise<void>(resolve=>{finishUnlock=resolve})
  SpeechOutputPlayer.prototype.enqueue=function(sentences){spoken.push(...sentences)}
  SpeechOutputPlayer.prototype.stop=function(){stops++;stop.call(this)}
  window.addEventListener(DIGITAL_OUTPUT_FRAME,(event:Event)=>frames.push((event as CustomEvent).detail))
  const profile={enabled:true,name:'助手',role:'',personality:'',duties:'',avatar:'robot' as const,greeting:'',auto_speak:true}
  const old:AssistantChatMessage={id:'old',role:'assistant',content:'历史回复。',status:'succeeded'}
  const running:AssistantChatMessage={id:'new',role:'assistant',content:'新回复。',status:'running'}
  const render=(messages:AssistantChatMessage[],active=true,blockNew=false)=>act(async()=>root.render(<I18nProvider><DigitalPersonSpeech ref={controls} profile={profile} projectId="manual-reply" sessionId="s" messages={messages} active={active} blockNew={blockNew} manualEnabled={!blockNew}/></I18nProvider>))
  try{
    await render([old,running])
    const before=stops
    await act(async()=>{controls.current!.toggle('old')})
    assert.ok(stops>before)
    assert.equal(frames.at(-1)?.busy,true)
    assert.equal(frames.at(-1)?.readingId,'old')
    await act(async()=>finishUnlock())
    assert.deepEqual(spoken,['新回复。','历史回复。'])
    const beforeBlocking=stops
    await render([old,running],true,true)
    await render([old,running],false)
    assert.equal(stops,beforeBlocking)
    assert.equal(frames.at(-1)?.readingId,'old')
    await render([old,running])
    await act(async()=>controls.current!.toggle('old'))
    assert.equal(frames.at(-1)?.busy,false)
    assert.equal(frames.at(-1)?.readingId,undefined)
    await render([old,{...running,content:'新回复。后续文字。',status:'succeeded'}])
    assert.deepEqual(spoken,['新回复。','历史回复。'],'interrupted auto speech never resumes')
  }finally{
    await act(async()=>root.unmount());await window.happyDOM.close()
    speechOutputApi.status=status;Object.assign(SpeechOutputPlayer.prototype,{unlock,enqueue,stop})
  }
})

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
    await render([message('early', '我已经核对了构建结果，接下来', 'running')])
    assert.equal(spoken.at(-1), '我已经核对了构建结果，', 'the opening clause is queued before the reply has a full sentence')
    await render([message('early', '我已经核对了构建结果，接下来检查布局，随后给出结论。', 'running')])
    assert.deepEqual(spoken.slice(4), ['我已经核对了构建结果，', '接下来检查布局，随后给出结论。'])
    const opening = '数字人目前正在逐项核对桌面与手机上的消息显示语音播报和用户操作并确认不同网络环境下都可以正常使用这些功能'
    await render([message('long', opening, 'running')])
    const first = spoken.at(-1)!
    assert.ok(first.length < opening.length && opening.startsWith(first), 'an opening without punctuation also starts before completion')
    await render([message('long', opening, 'succeeded')])
    assert.equal(spoken.slice(6).join(''), opening, 'early chunks and the final tail reconstruct the reply once')

    const beforeTable = spoken.length
    const header = '检查结果。\n\n项目 | 状态\n'
    await render([message('table', '检查结果。\n\n项目', 'running')])
    await render([message('table', header, 'running')])
    await render([message('table', header + ':--- | --', 'running')])
    assert.deepEqual(spoken.slice(beforeTable), ['检查结果。'])
    const aligned = header + ':--- | ---:\n'
    await render([message('table', aligned + '| 构建 | 通过！', 'running')])
    assert.deepEqual(spoken.slice(beforeTable), ['检查结果。', '项目，状态。'])
    await render([message('table', aligned + '| 构建 | 通过！ |\n| 测试 | 完成 |', 'running')])
    await render([message('table', aligned + '| 构建 | 通过！ |\n| 测试 | 完成 |', 'succeeded')])
    assert.deepEqual(spoken.slice(beforeTable), ['检查结果。', '项目，状态。', '构建，通过！', '测试，完成。'])

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
 const render=(messages:AssistantChatMessage[])=>act(async()=>root.render(<I18nProvider><DigitalPersonSpeech profile={profile} projectId="synthesis-gap" sessionId="s" messages={messages} active/></I18nProvider>))
 try{
  await render([])
  await render([{id:'new',role:'assistant',content:'第一句话。',status:'running'}])
  assert.ok(frames.some(frame=>frame.busy&&!frame.playing&&frame.projectId==='synthesis-gap'))
  await act(async()=>ready({id:'audio'}))
  assert.equal(frames.at(-1).busy,false)
 }finally{await act(async()=>root.unmount());Object.assign(speechOutputApi,original);await window.happyDOM.close()}
})

test('retry keeps streaming text after a failure and stop clears the retry action', async () => {
  const {window}=installDomEnvironment(), root=createRoot(document.body.appendChild(document.createElement('div')))
  const original={...speechOutputApi}, started:string[]=[]
  speechOutputApi.status=async()=>({...outputStatus,settings:{...outputStatus.settings,mode:'remote'}})
  speechOutputApi.start=async text=>{started.push(text);return {id:String(started.length)}}
  speechOutputApi.next=async()=>({done:true,error:'语音服务认证失败',error_code:'authentication'})
  speechOutputApi.cancel=async()=>{}
  const profile={enabled:true,name:'助手',role:'',personality:'',duties:'',avatar:'robot' as const,greeting:'',auto_speak:true}
  const reply:AssistantChatMessage={id:'new',role:'assistant',content:'第一句话。',status:'running'}
  const render=(message:AssistantChatMessage)=>act(async()=>root.render(<I18nProvider><DigitalPersonSpeech profile={profile}
    projectId="retry-reply" sessionId="s" messages={[message]} active/></I18nProvider>))
  try {
    await render(reply)
    assert.equal(document.querySelector('[role=alert]')?.textContent,'语音服务认证失败')
    await render({...reply,content:'第一句话。后来还有一句。',status:'succeeded'})
    assert.deepEqual(started,['第一句话。'])
    const retry=document.querySelector('button')
    assert.ok(retry && !retry.disabled)
    await act(async()=>retry.click())
    assert.deepEqual(started,['第一句话。','第一句话。','后来还有一句。'])
    await act(async()=>stopDigitalSpeech('retry-reply','s'))
    assert.equal(document.querySelector('button'),null)
    assert.equal(document.querySelector('[role=alert]'),null)
  } finally { await act(async()=>root.unmount()); Object.assign(speechOutputApi,original); await window.happyDOM.close() }
})
