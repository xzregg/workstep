import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import DigitalPersonSpeech, {type DigitalPersonSpeechControls} from '../src/components/digital-person/DigitalPersonSpeech'
import {DIGITAL_OUTPUT_FRAME,stopDigitalSpeech,type DigitalOutputFrame} from '../src/components/digital-person/digitalPersonVoiceEvents'
import type { AssistantChatEvent, AssistantChatMessage } from '../src/stores/assistantStore'
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
  const old:AssistantChatMessage={id:'old',role:'assistant',content:'历史回复。第二句话。\n还有第三句。',status:'succeeded'}
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
    assert.deepEqual(spoken,['新回复。',old.content])
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
    assert.deepEqual(spoken,['新回复。',old.content],'interrupted auto speech never resumes')
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

test('automatic speech merges sentences from separate renders and includes the final tail', async () => {
  const { window } = installDomEnvironment(), root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechOutputApi }, started: string[] = []
  let finishOpening!: (value: { done: boolean }) => void
  speechOutputApi.status = async () => ({ ...outputStatus, settings: { ...outputStatus.settings, mode: 'remote' } })
  speechOutputApi.start = async text => { started.push(text); return { id: String(started.length) } }
  speechOutputApi.next = async id => id === '1' ? new Promise(resolve => { finishOpening = resolve }) : { done: true }
  speechOutputApi.cancel = async () => {}
  const profile = { enabled: true, name: '助手', role: '', personality: '', duties: '', avatar: 'robot' as const, greeting: '', auto_speak: true }
  const render = (content: string, status: AssistantChatMessage['status'] = 'running') => act(async () => root.render(
    <I18nProvider><DigitalPersonSpeech profile={profile} projectId="batch-stream" sessionId="s"
      messages={[{ id: 'reply', role: 'assistant', content, status }]} active /></I18nProvider>))
  try {
    await render('首句。')
    await render('首句。第二句。')
    await render('首句。第二句。她问：“第三句？！”还有尾巴')
    assert.deepEqual(started, ['首句。'])
    await render('首句。第二句。她问：“第三句？！”还有尾巴', 'succeeded')
    assert.deepEqual(started, ['首句。', '第二句。她问：“第三句？！”还有尾巴'])
    await act(async () => finishOpening({ done: true }))
    assert.equal(started.length, 2)
  } finally {
    await act(async () => { root.unmount(); finishOpening?.({ done: true }) })
    Object.assign(speechOutputApi, original)
    await window.happyDOM.close()
  }
})

test('the answer follows the audible commentary and skips all waiting updates', async () => {
  const { window } = installDomEnvironment(), root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechOutputApi }
  const sent: { type: string; id: string; text?: string }[] = []
  const bridge: NonNullable<Window['WorkStepSpeech']> = {
    postMessage: message => sent.push(JSON.parse(message)),
    onmessage: null,
  }
  Object.defineProperty(window, 'WorkStepSpeech', { configurable: true, value: bridge })
  speechOutputApi.status = async () => structuredClone(outputStatus)
  const spoken = () => sent.filter(message => message.type === 'speak').map(message => message.text)
  const finish = () => act(async () => bridge.onmessage!({ data: JSON.stringify({ id: sent.at(-1)?.id, status: 'done' }) }))
  const profile = { enabled: true, name: '助手', role: '', personality: '', duties: '', avatar: 'robot' as const, greeting: '', auto_speak: true }
  const commentary = (delta: string, source_item_id = 'opening'): AssistantChatEvent =>
    ({ type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', role: 'assistant', delta, source_item_id })
  const tool: AssistantChatEvent = { type: 'TOOL_CALL_START', toolCallId: 'lookup' }
  const reasoning: AssistantChatEvent = { type: 'REASONING_MESSAGE_CHUNK', delta: '我需要先分析用户意图。' }
  const render = (id: string, events: AssistantChatEvent[], options: Partial<AssistantChatMessage> = {}, muted = false) =>
    act(async () => root.render(<I18nProvider><DigitalPersonSpeech profile={profile} projectId="commentary-speech" sessionId="s"
      messages={[{ id, role: 'assistant', events, content: '', status: 'running', ...options }]} active muted={muted} /></I18nProvider>))
  try {
    await render('history', [commentary('我查一下历史记录。')], { status: 'succeeded' })
    await render('reply', [reasoning, commentary('我查一下')])
    assert.deepEqual(spoken(), [])
    const opening = [reasoning, commentary('我查一下'), commentary('今天的记录。')]
    await render('reply', opening)
    assert.deepEqual(spoken(), ['我查一下今天的记录。'])
    const events = [...opening, tool, commentary('我再核对一下。', 'second')]
    await render('reply', events)
    await finish()
    assert.deepEqual(spoken(), ['我查一下今天的记录。', '我再核对一下。'])
    const waiting = [...events, commentary('我整理一下。', 'third'), commentary('马上就好。', 'fourth')]
    await render('reply', waiting)
    await render('reply', waiting, { content: '今天完成了' })
    assert.equal(sent.length, 2, 'the second progress sentence is still playing')
    await finish()
    assert.equal(sent.length, 2, 'pending progress is dropped even before a full answer sentence is ready')
    await render('reply', [...waiting, commentary('这是迟到的进度。', 'late')], { content: '今天完成了两项工作。', status: 'succeeded' })
    assert.deepEqual(spoken(), ['我查一下今天的记录。', '我再核对一下。', '今天完成了两项工作。'])
    await finish()

    await render('muted', [commentary('我查一下。')], {}, true)
    await render('muted', [commentary('我查一下。')])
    await render('long', [commentary('我仔细想一想'.repeat(20) + '。'), tool])
    assert.equal(spoken().length, 3)
    await render('long', [commentary('我仔细想一想'.repeat(20) + '。'), tool, commentary('已经找到记录。', 'found')])
    assert.equal(spoken().at(-1), '已经找到记录。')
    await finish()
    await render('no-punctuation', [commentary('我先看看')])
    assert.equal(spoken().length, 4)
    await render('no-punctuation', [commentary('我先看看'), tool])
    assert.equal(spoken().at(-1), '我先看看')
    const beforeAnswer = sent.length
    await render('no-punctuation', [commentary('我先看看'), tool, commentary('马上回来。', 'next')], { content: '查到了。' })
    assert.equal(sent.length, beforeAnswer, 'the complete answer does not interrupt the current sentence')
    await finish()
    assert.equal(sent.at(-1)?.text, '查到了。')
    assert.ok(sent.every(message => message.type === 'speak'))
    await finish()

    const limitSentence = '查'.repeat(47) + '。'
    const overLimitSentence = '再' + limitSentence
    const beforeLimit = spoken()
    await render('character-limit', [commentary(overLimitSentence, 'too-long')])
    assert.deepEqual(spoken(), beforeLimit, 'a 49-character opening is skipped in full')
    await render('character-limit', [commentary(overLimitSentence, 'too-long'), commentary(limitSentence, 'fits')])
    assert.deepEqual(spoken(), [...beforeLimit, limitSentence], 'a 48-character opening is spoken in full')
    await finish()
  } finally {
    await act(async () => root.unmount())
    Object.assign(speechOutputApi, original)
    await window.happyDOM.close()
  }
})

test('the answer cancels a progress sentence that is still being synthesized', async () => {
  const { window } = installDomEnvironment(), root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechOutputApi }
  const started: string[] = [], fetched: string[] = [], cancelled: string[] = []
  let releaseProgress!: (value: { id: string }) => void
  speechOutputApi.status = async () => ({ ...outputStatus, settings: { ...outputStatus.settings, mode: 'remote' } })
  speechOutputApi.start = async text => {
    started.push(text)
    return started.length === 1 ? new Promise(resolve => { releaseProgress = resolve }) : { id: 'answer' }
  }
  speechOutputApi.next = async id => { fetched.push(id); return { done: true } }
  speechOutputApi.cancel = async id => { cancelled.push(id) }
  const profile = { enabled: true, name: '助手', role: '', personality: '', duties: '', avatar: 'robot' as const, greeting: '', auto_speak: true }
  const events = [{ type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', delta: '我先查一下。' }]
  const render = (content: string) => act(async () => root.render(<I18nProvider><DigitalPersonSpeech profile={profile}
    projectId="commentary-cancel" sessionId="s" messages={[{ id: 'reply', role: 'assistant', events, content, status: 'running' }]} active /></I18nProvider>))
  try {
    await render('')
    assert.deepEqual(started, ['我先查一下。'])
    await render('已经查到了。')
    assert.deepEqual(started, ['我先查一下。', '已经查到了。'])
    await act(async () => releaseProgress({ id: 'progress' }))
    assert.deepEqual(fetched, ['answer'])
    assert.ok(cancelled.includes('progress'))
  } finally {
    await act(async () => { root.unmount(); releaseProgress?.({ id: 'progress' }) })
    Object.assign(speechOutputApi, original)
    await window.happyDOM.close()
  }
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
    assert.ok(document.querySelector('button') === null)
    assert.ok(document.querySelector('[role=alert]') === null)
  } finally { await act(async()=>root.unmount()); Object.assign(speechOutputApi,original); await window.happyDOM.close() }
})
