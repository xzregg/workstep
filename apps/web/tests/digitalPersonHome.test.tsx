import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter,useLocation} from 'react-router-dom'
import {I18nProvider} from '../src/i18n'
import DigitalPersonHome from '../src/components/digital-person/DigitalPersonHome'
import {speechOutputApi} from '../src/api/speechOutput'
import {digitalRuntimeApi,digitalAffectApi} from '../src/api/digitalPerson'
import {speechApi} from '../src/api/speech'
import {voiceCapture} from '../src/utils/voiceCapture'
import {SpeechOutputPlayer} from '../src/utils/speechOutput'
import {outputStatus} from './fixtures/speechOutput'
import {getProactiveSpeechContext} from '../src/components/digital-person/digitalPersonProactive'
import {DIGITAL_OUTPUT_FRAME} from '../src/components/digital-person/digitalPersonVoiceEvents'
const profile={enabled:true,name:'小研',role:'研发伙伴',personality:'直接',duties:'跟进工作',avatar:'robot' as const,greeting:'今天想做什么？'}

test('avatar home uses real conversation and delegated state, text view and return to workbench',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStatus=speechOutputApi.status;speechOutputApi.status=async()=>structuredClone(outputStatus)
 let path=''
 function Location(){path=useLocation().pathname;return null}
 try{
  await act(async()=>root.render(<MemoryRouter initialEntries={['/companion']}><I18nProvider><DigitalPersonHome profile={profile} activity={{delegations:[{id:'work',project_id:'p',session_id:'exec',instruction:'核验构建',status:'running'}]} as any} projectId="p" projectName="默认工作区" sessionId="main" messages={[{id:'u',role:'user',content:'帮我检查构建'},{id:'a',role:'assistant',content:'正在处理',status:'running'}]} inputValue="" onDraft={()=>{}} running active onSend={async()=>true} onStop={async()=>true}><div data-transcript>原有对话组件</div></DigitalPersonHome><Location/></I18nProvider></MemoryRouter>))
  assert.equal(host.querySelector('[data-affect-readonly],.digital-affect'),null)
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'thinking')
  assert.match(host.querySelector('.digital-home-work')!.textContent!,/核验构建/)
  assert.equal(host.querySelector('[data-transcript]'),null)
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'other',sessionId:'main',playing:true,level:1}})))
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'thinking')
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'main',playing:true,level:.6}})))
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'speaking')
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-keyboard')!.click())
  assert.equal(host.querySelector('[data-transcript]'),null)
  assert.ok(host.querySelector('.digital-home-composer textarea'))
  assert.ok(host.querySelector('.digital-home-stage'))
  assert.equal(host.querySelector('.digital-home-voice-hint'),null)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-transcript-button')!.click())
  assert.ok(host.querySelector('[data-transcript]'))
  assert.equal(host.querySelector('.digital-home-composer'),null)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-back')!.click())
  assert.equal(path,'/chat')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();speechOutputApi.status=oldStatus}
})

test('voice starts only by gesture, mute releases capture and hiding never restarts microphone',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStatus=speechOutputApi.status,oldStart=voiceCapture.start,oldSpeech={...speechApi}
 let captures=0,stops=0
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 voiceCapture.start=async()=>{captures++;return {stop:()=>stops++,flush:async()=>{}}}
 speechApi.start=async()=>({id:'voice',sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome profile={profile} activity={null} projectId="p" projectName="默认工作区" sessionId="main" messages={[]} inputValue="" onDraft={()=>{}} running={false} active onSend={async()=>true} onStop={async()=>true}/></I18nProvider></MemoryRouter>))
  assert.equal(captures,0)
  assert.equal(host.querySelector<HTMLButtonElement>('.digital-home-end')!.disabled,true, 'idle has no dialogue to end')
  const speaker=host.querySelector<HTMLButtonElement>('.digital-home-speaker')
  assert.ok(speaker, 'speaker control is available independently of capture')
  assert.equal(speaker.getAttribute('aria-pressed'),'true')
  await act(async()=>speaker.click())
  assert.equal(speaker.getAttribute('aria-pressed'),'false')
  assert.equal(captures,0)
  assert.ok(host.querySelector('[data-camera-toggle]'), 'camera has a dedicated entry')
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-microphone')!.click())
  assert.equal(captures,1)
  assert.equal(host.querySelector<HTMLButtonElement>('.digital-home-end')!.disabled,false, 'started dialogue can be ended')
  assert.equal(host.querySelector('.digital-home-microphone')?.getAttribute('aria-pressed'),'true')
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-microphone')!.click())
  assert.equal(captures,1);assert.ok(stops>0)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-microphone')!.click())
  assert.equal(captures,2)
  Object.defineProperty(document,'hidden',{configurable:true,value:true})
  await act(async()=>document.dispatchEvent(new window.Event('visibilitychange')))
  assert.equal(host.querySelector('.digital-home-microphone')?.getAttribute('aria-pressed'),'false')
  Object.defineProperty(document,'hidden',{configurable:true,value:false})
  await act(async()=>document.dispatchEvent(new window.Event('visibilitychange')))
  assert.equal(captures,2)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();speechOutputApi.status=oldStatus;voiceCapture.start=oldStart;Object.assign(speechApi,oldSpeech)}
})

test('keyboard sends into same session and speaker enables sentence playback without global auto speak',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStatus=speechOutputApi.status,oldEnqueue=SpeechOutputPlayer.prototype.enqueue,oldStop=SpeechOutputPlayer.prototype.stop
 const spoken:string[]=[],sent:string[]=[]
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 SpeechOutputPlayer.prototype.enqueue=function(sentences){spoken.push(...sentences)}
 SpeechOutputPlayer.prototype.stop=function(){}
 let reply=(content:string)=>{}
 function App(){
  const [input,setInput]=useState(''),[messages,setMessages]=useState<any[]>([{id:'old',role:'assistant',content:'历史。',status:'succeeded'}])
  reply=content=>setMessages([{id:'new',role:'assistant',content,status:'running'}])
  return <MemoryRouter><I18nProvider><DigitalPersonHome profile={{...profile,auto_speak:false}} activity={null} projectId="p" projectName="默认工作区" sessionId="main" messages={messages} running={false} active inputValue={input} onDraft={setInput} onSend={async text=>{sent.push(text);setInput('');reply('第一句。第二');return true}} onStop={async()=>true}/></I18nProvider></MemoryRouter>
 }
 try{
  await act(async()=>root.render(<App/>))
  assert.deepEqual(spoken,[])
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-keyboard')!.click())
  const input=host.querySelector<HTMLTextAreaElement>('.digital-home-composer textarea')!
  assert.ok(input)
  assert.equal(document.activeElement,input)
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'帮我看看');input.dispatchEvent(new window.Event('input',{bubbles:true}))})
  await act(async()=>host.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
  assert.deepEqual(sent,['帮我看看'])
  assert.deepEqual(spoken,['第一句。'])
  await act(async()=>reply('第一句。第二句！'))
  assert.deepEqual(spoken,['第一句。','第二句！'])
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-transcript-button')!.click())
  assert.equal(getProactiveSpeechContext()?.muted,true,'history suspends proactive automatic speech too')
  await act(async()=>reply('第一句。第二句！历史查看期间不播报。'))
  assert.equal(spoken.length,2,'history list never auto plays replies')
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-chat header button')!.click())
  assert.equal(spoken.length,2,'closing dialogue does not replay its reply')
  assert.equal(getProactiveSpeechContext()?.muted,false)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-speaker')!.click())
  await act(async()=>reply('第一句。第二句！静音。'))
  assert.equal(spoken.length,2)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();speechOutputApi.status=oldStatus;SpeechOutputPlayer.prototype.enqueue=oldEnqueue;SpeechOutputPlayer.prototype.stop=oldStop}
})

test('switching sessions cannot carry the previous voice glow into the new avatar',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStatus=speechOutputApi.status;speechOutputApi.status=async()=>structuredClone(outputStatus)
 const render=(sessionId:string)=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome profile={profile} activity={null} projectId="p" projectName="p" sessionId={sessionId} messages={[]} inputValue="" onDraft={()=>{}} running={false} active onSend={async()=>true} onStop={async()=>true}/></I18nProvider></MemoryRouter>)
 try{
  await act(async()=>render('a'))
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'a',playing:false,level:0,busy:true}})))
  assert.equal(host.querySelector<HTMLButtonElement>('.digital-home-end')!.disabled,false,'pending synthesis can be stopped before sound starts')
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'a',playing:true,level:.8}})))
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'speaking')
  await act(async()=>render('b'))
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'idle')
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'a',playing:true,level:.8}})))
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'idle')
 }finally{await act(async()=>root.unmount());speechOutputApi.status=oldStatus;await window.happyDOM.close()}
})

test('opening and closing transcript preserves the same live camera stream',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),oldStatus=speechOutputApi.status
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 let starts=0,stops=0
 const track={stop(){stops++},addEventListener(){},readyState:'live'}
 const stream={getTracks:()=>[track],getVideoTracks:()=>[track]}
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{starts++;return stream}}})
 Object.defineProperty(window.HTMLVideoElement.prototype,'srcObject',{configurable:true,writable:true,value:null})
 window.HTMLVideoElement.prototype.play=async()=>{}
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome profile={profile} activity={null} projectId="p" projectName="p" sessionId="main" messages={[]} inputValue="" onDraft={()=>{}} running={false} active onSend={async()=>true} onStop={async()=>true}><div data-transcript>完整对话</div></DigitalPersonHome></I18nProvider></MemoryRouter>))
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-camera-toggle]')!.click())
  const video=host.querySelector('video')!
  assert.equal(video.srcObject,stream)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-transcript-button')!.click())
  assert.ok(host.querySelector('[data-transcript]'));assert.equal(stops,0);assert.equal(host.querySelector('video'),video);assert.equal(video.srcObject,stream)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-chat header button')!.click())
  assert.equal(starts,1);assert.equal(stops,0);assert.equal(video.srcObject,stream)
  await act(async()=>root.unmount());assert.equal(stops,1)
 }finally{await act(async()=>root.unmount());speechOutputApi.status=oldStatus;await window.happyDOM.close()}
})


test('presence corner uses the real digital person, affinity and reflection total without duplicate identity',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldRecords=digitalRuntimeApi.records,oldAffect=digitalAffectApi.read,oldStatus=speechOutputApi.status
 digitalRuntimeApi.records=async()=>({reflection_count:237,run_total:100,delegation_total:0,checking:false,delegations:[],runs:[{id:'r1',status:'completed',summary:'已整理上下文',created_at:'2026-11-16T01:00:00Z'}]})
 digitalAffectApi.read=async()=>({state:{person_id:'person',name:'真实会话作者',affinity:71,emotion:'calm',valence:0,arousal:0,updated_at:null,history:[]}})
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome profile={profile} activity={{level:8,delegations:[]} as any} projectId="p" projectName="p" sessionId="main" messages={[]} inputValue="" onDraft={()=>{}} running={false} active onSend={async()=>true} onStop={async()=>true}/></I18nProvider></MemoryRouter>))
  assert.equal(host.querySelectorAll('.digital-home-identity').length,1)
  const corner=host.querySelector('.digital-home-presence-info')!
  assert.match(corner.textContent!,/小研/);assert.match(corner.textContent!,/Lv.8/)
  assert.match(corner.textContent!,/71/);assert.match(corner.textContent!,/237/)
  assert.doesNotMatch(corner.textContent!,/真实会话作者|示例|执行次数/)
  assert.ok(host.querySelector('.digital-presence-orb'))
  assert.equal(host.querySelector('.digital-home-avatar img'),null)
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'main',playing:true,level:.7}})))
  assert.match(corner.textContent!,/正在回应/)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=oldRecords;digitalAffectApi.read=oldAffect;speechOutputApi.status=oldStatus;await window.happyDOM.close()}
})
