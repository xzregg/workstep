import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import DigitalPersonCaptions from '../src/components/digital-person/DigitalPersonCaptions'
import {digitalRuntimeApi} from '../src/api/digitalPerson'
import {resolveMarkdownImageSrc} from '../src/utils/markdownImages'
import type {AssistantChatMessage} from '../src/stores/assistantStore'

test('the transcript shows short progress before the answer and restores it from history',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const events=[
  {type:'REASONING_MESSAGE_CHUNK',delta:'内部推理'},
  {type:'TEXT_MESSAGE_CHUNK',phase:'commentary',source_item_id:'a',delta:'我查一下'},
  {type:'TEXT_MESSAGE_CHUNK',phase:'commentary',source_item_id:'a',delta:'今天的记录。'},
  {type:'TEXT_MESSAGE_CHUNK',phase:'commentary',source_item_id:'b',delta:'再'.repeat(49)+'。'},
 ]
 const render=(reply:Partial<AssistantChatMessage>)=>act(async()=>root.render(<I18nProvider><DigitalPersonCaptions
  projectId="p" sessionId="main" greeting="你好" liveText="" messages={[{id:'a',role:'assistant',content:'',status:'running',...reply}]}/></I18nProvider>))
 try{
  await render({events})
  assert.equal(host.querySelector('.digital-person-progress')?.textContent,'我查一下今天的记录。')
  assert.doesNotMatch(host.textContent!,/内部推理|再再/)
  await render({content:'这是今天的结果。',status:'succeeded',event_summary:{commentary_preview:[{text:'我查一下今天的记录。',complete:true}]}})
  assert.match(host.querySelector('.digital-home-reply')!.textContent!,/我查一下今天的记录。.*这是今天的结果。/)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('thinking shows elapsed time from the current reply and only finished replies can be read aloud',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const now=Date.now,started=now()-3000,played:string[]=[]
 let elapsed=3000
 const locale=useLocaleStore.getState().locale
 useLocaleStore.setState({locale:'zh-CN'})
 Date.now=()=>started+elapsed
 const reply:AssistantChatMessage={id:'a',role:'assistant',content:'',status:'running',created_at:new Date(started).toISOString()}
 const render=(message:AssistantChatMessage,readingId?:string)=>act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" messages={[message]} greeting="你好" liveText="" readingId={readingId} onToggleSpeech={id=>played.push(id)}/></I18nProvider>))
 try{
  await render(reply)
  assert.match(host.textContent!,/正在思考\s*3秒/)
  assert.ok(host.querySelector('[aria-label="朗读回复"]') === null)
  elapsed=4000
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1050))})
  assert.match(host.textContent!,/正在思考\s*4秒/)
  await render({...reply,content:'这是回复。',status:'succeeded'})
  assert.doesNotMatch(host.textContent!,/正在思考/)
  const row=host.querySelector('.digital-home-reply-actions')!
  assert.ok(row.querySelector('[aria-pressed]'),'feedback remains beside playback')
  await act(async()=>row.querySelector<HTMLButtonElement>('[aria-label="朗读回复"]')!.click())
  await render({...reply,content:'这是回复。',status:'succeeded'},'a')
  await act(async()=>row.querySelector<HTMLButtonElement>('[aria-label="停止朗读"]')!.click())
  assert.deepEqual(played,['a','a'])
 }finally{Date.now=now;await act(async()=>root.unmount());useLocaleStore.setState({locale});await window.happyDOM.close()}
})

test('captions retain earlier turns and follow new text only while reading the latest turn',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 window.matchMedia=(()=>({matches:true,addEventListener(){},removeEventListener(){}})) as typeof window.matchMedia
 const messages=[{id:'u',role:'user' as const,content:'之前的问题'},{id:'a',role:'assistant' as const,content:'完整回复。'.repeat(80),status:'running' as const}]
 const render=async(content:string)=>act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" messages={[messages[0],{...messages[1],content}]} greeting="你好" liveText=""/></I18nProvider>))
 try{
  await render(messages[1].content)
  const history=host.querySelector<HTMLElement>('.digital-home-subtitles')!
  let scrollHeight=1200
  Object.defineProperties(history,{scrollHeight:{get:()=>scrollHeight},clientHeight:{value:300}})
  await render(messages[1].content+'下一句。')
  assert.equal(history.scrollTop,900)
  assert.match(history.textContent!,/之前的问题/)
  assert.ok(history.textContent!.includes(messages[1].content))
  history.scrollTop=890
  await act(async()=>history.dispatchEvent(new window.Event('scroll')))
  scrollHeight=1250
  await render(messages[1].content+'新内容。')
  assert.equal(history.scrollTop,890,'even a short upward drag pauses following')
  history.scrollTop=950
  await act(async()=>history.dispatchEvent(new window.Event('scroll')))
  scrollHeight=1300
  await render(messages[1].content+'继续。')
  assert.equal(history.scrollTop,1000)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('captions hide camera processing details while preserving ordinary images and assistant Markdown',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" greeting="你好" liveText="" messages={[
   {id:'u',role:'user',content:'看到我是谁吗\n\n[本轮附图的人脸识别观察（可能有误）]\n{"people":[{"person_id":"p1","name":"小谢","relationship":"主人"}],"unknown_face_count":0}\n这些是画面中的人物，不代表谁正在发言；不改变消息作者或权限。\n\n![camera-123.jpg](.workstep/uploads/digital-person-camera-123.jpg)'},
   {id:'photo',role:'user',content:'看这张图\n\n![照片](.workstep/uploads/photo.jpg)'},
   {id:'a',role:'assistant',content:'**分析结果**\n\n![结果图](.workstep/uploads/result.png)',status:'succeeded'},
  ]}/></I18nProvider>))
  const images=host.querySelectorAll('img')
  assert.equal(images.length,2)
  assert.match(host.querySelector('.digital-home-user-caption')!.textContent!,/看到我是谁吗/)
  assert.doesNotMatch(host.textContent!,/person_id|小谢|人脸识别观察|unknown_face_count|不改变消息作者/)
  assert.equal(images[0].getAttribute('src'),resolveMarkdownImageSrc('.workstep/uploads/photo.jpg','p'))
  assert.equal(images[1].getAttribute('src'),resolveMarkdownImageSrc('.workstep/uploads/result.png','p'))
  assert.equal(host.querySelector('.digital-home-reply strong')?.textContent,'分析结果')
  await act(async()=>images[0].click())
  assert.ok(document.querySelector('.image-preview'),'image opens shared preview outside the fading scroll area')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('avatar transcript feedback restores historical votes and submits the original assistant message ID',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original=digitalRuntimeApi.feedback,calls:Array<[string,number]>=[]
 digitalRuntimeApi.feedback=async(id,value)=>{calls.push([id,value]);return {} as any}
 const messages=[{id:'user',role:'user',content:'问题',status:'succeeded'},{id:'old-answer',role:'assistant',content:'历史回复',status:'succeeded'},{id:'running',role:'assistant',content:'正在生成',status:'running'},{id:'empty',role:'assistant',content:'',status:'succeeded'}] as any
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" messages={messages} feedback={{'old-answer':1}} greeting="你好" liveText=""/></I18nProvider>))
  assert.equal(host.querySelectorAll('.digital-person-feedback').length,1,'only completed nonempty assistant replies offer feedback')
  const [up,down]=host.querySelectorAll<HTMLButtonElement>('.digital-person-feedback button')
  assert.equal(up.getAttribute('aria-pressed'),'true')
  assert.ok(up.closest('.chat-message-row'),'uses shared desktop hover/mobile visibility')
  await act(async()=>down.click())
  assert.deepEqual(calls,[['old-answer',-1]])
  assert.equal(up.getAttribute('aria-pressed'),'false');assert.equal(down.getAttribute('aria-pressed'),'true')
  await act(async()=>down.click())
  assert.deepEqual(calls.at(-1),['old-answer',0])
 }finally{digitalRuntimeApi.feedback=original;await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('live recognition stays outside scrolling history and revises the same preview before submission',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const messages=[{id:'old',role:'assistant' as const,content:'之前的长回复。'.repeat(80),status:'succeeded' as const}]
 const render=(liveText:string,voicePhase?:'recording'|'finishing')=>act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" messages={messages} greeting="你好" liveText={liveText} voicePhase={voicePhase}/></I18nProvider>))
 try{
  await render('','recording')
  const history=host.querySelector<HTMLElement>('.digital-home-subtitles')!
  const live=host.querySelector<HTMLElement>('.digital-home-live-caption')!
  assert.ok(live,'listening has an immediately visible recognition area')
  assert.equal(live.getAttribute('role'),'status')
  assert.equal(history.contains(live),false,'history scrolling cannot hide recognition')
  Object.defineProperties(history,{scrollHeight:{value:1800,configurable:true},clientHeight:{value:300,configurable:true}})
  history.scrollTop=100;await act(async()=>history.dispatchEvent(new window.Event('scroll')))
  await render('帮我检查','recording')
  assert.ok(host.querySelector('.digital-home-live-caption') === live)
  assert.match(live.textContent!,/帮我检查/)
  await render('帮我检查今天的安排','recording')
  assert.match(live.textContent!,/帮我检查今天的安排/)
  assert.equal(history.scrollTop,100,'recognition does not pull the reader away from history')
  assert.doesNotMatch(history.textContent!,/帮我检查/)
  await render('帮我检查今天的安排','finishing')
  assert.equal(live.getAttribute('data-phase'),'finishing')
  await render('')
  assert.ok(host.querySelector('.digital-home-live-caption') === null, 'cancelled or accepted preview is removed')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('mobile recognition keeps one text-only preview across voice phases',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 window.matchMedia=(()=>({matches:true,addEventListener(){},removeEventListener(){}})) as typeof window.matchMedia
 const render=(liveText:string,voicePhase?:'recording'|'finishing')=>act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" messages={[]} greeting="你好" liveText={liveText} voicePhase={voicePhase}/></I18nProvider>))
 try{
  await render('','recording')
  const live=host.querySelector<HTMLElement>('.digital-home-live-caption')!
  const text=live.querySelector('p')!
  assert.equal(live.textContent,'')
  assert.equal(live.children.length,1)
  await render('帮我检查','recording')
  assert.ok(live.firstElementChild === text)
  assert.equal(live.textContent,'帮我检查')
  const firstReveal=text.querySelector('.digital-home-live-caption-reveal')!
  assert.equal(firstReveal.textContent,'帮我检查')
  await render('帮我检查','finishing')
  assert.ok(text.querySelector('.digital-home-live-caption-reveal') === firstReveal, 'phase changes do not replay the text')
  await render('帮我检查今天的安排','finishing')
  assert.ok(host.querySelector('.digital-home-live-caption') === live)
  assert.ok(live.firstElementChild === text)
  assert.equal(live.textContent,'帮我检查今天的安排')
  assert.equal(text.querySelector('.digital-home-live-caption-reveal')?.textContent,'今天的安排')
  await render('帮我检查明天的安排','finishing')
  assert.equal(text.querySelector('.digital-home-live-caption-reveal')?.textContent,'明天的安排')
  await render('')
  assert.ok(host.querySelector('.digital-home-live-caption') === null)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})


test('streaming and playback updates do not reprocess unchanged caption history',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 let reads=0
 const old:AssistantChatMessage={id:'old-stable',role:'assistant',status:'succeeded',get content(){reads++;return '**已完成**\n\n历史回复。'}}
 const playing=(id:string)=>{}
 const render=(content:string,readingId?:string)=>act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" messages={[old,{id:'live',role:'assistant',status:'running',content}]} greeting="你好" liveText="" readingId={readingId} onToggleSpeech={playing}/></I18nProvider>))
 try{
  await render('正在')
  reads=0
  await render('正在回复')
  assert.equal(reads,0,'a new token must not clean, scan commentary or prepare speech for old messages')
  await render('正在回复下一句','live')
  assert.equal(reads,0,'playing another message must not revisit history')
  assert.match(host.textContent!,/已完成.*历史回复/s)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
