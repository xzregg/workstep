import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act,StrictMode,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter,useLocation} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import DigitalPersonHome from '../src/components/digital-person/DigitalPersonHome'
import {wakeWordRuntime} from '../src/components/digital-person/DigitalPersonWake'
import {setWakeEnabled} from '../src/components/digital-person/wakePreferences'
import {speechOutputApi} from '../src/api/speechOutput'
import {pendingMessageInsertApi} from '../src/api/client'
import {digitalRuntimeApi,digitalAffectApi,voiceWakeApi} from '../src/api/digitalPerson'
import {speechApi} from '../src/api/speech'
import {useGatewaySessionStore, type GatewayRemoteSession} from '../src/stores/gatewaySessionStore'
import {voiceCapture} from '../src/utils/voiceCapture'
import {TurnController} from '../src/audio/turnController'
import {SpeechOutputPlayer} from '../src/utils/speechOutput'
import {outputStatus} from './fixtures/speechOutput'
import {getProactiveSpeechContext} from '../src/components/digital-person/digitalPersonProactive'
import {DIGITAL_OUTPUT_FRAME,STOP_DIGITAL_SPEECH} from '../src/components/digital-person/digitalPersonVoiceEvents'
import {clearDraft,saveDraft} from '../src/utils/chatDraft'
const profile={enabled:true,name:'小研',role:'研发伙伴',personality:'直接',duties:'跟进工作',avatar:'robot' as const,greeting:'今天想做什么？'}

test('conversation entry precedes face settings at every width and keeps the existing transcript action',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 useLocaleStore.setState({locale:'zh-CN'})
 const render=()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome profile={profile} activity={null} projectId="p" projectName="p" sessionId="main" messages={[]} inputValue="" onDraft={()=>{}} running={false} active onSend={async()=>true} onStop={async()=>true}><div data-transcript>历史对话</div></DigitalPersonHome></I18nProvider></MemoryRouter>)
 try{
  for(const width of [320,390,1023,1024,1440]){
   window.happyDOM.setWindowSize({width,height:900})
   await act(async()=>render())
   const button=host.querySelector<HTMLButtonElement>('.digital-home-dock-transcript')!
   assert.equal(host.querySelectorAll('.digital-home-dock-transcript').length,1)
   assert.equal(button.getAttribute('aria-label'),'展开对话')
   assert.ok(button.closest('.digital-home-header'))
   assert.ok(button.nextElementSibling?.matches('.digital-home-face-entry'))
   assert.ok(host.querySelector('.digital-home-input-actions') === null)
  }
  window.happyDOM.setWindowSize({width:320,height:900})
  await act(async()=>render())
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-header .digital-home-dock-transcript')!.click())
  assert.ok(host.querySelector('[data-transcript]'))
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-chat header button')!.click())
  assert.ok(host.querySelector('[data-transcript]') === null)
  assert.ok(host.querySelector('.digital-home-header .digital-home-dock-transcript'))
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('pending engine interactions reveal the existing conversation once and ignore answered history',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const request=(id:string)=>({type:'interaction_request',data:{interaction_id:id,method:'session/request_permission',tool_call:{tool_call_id:id,name:'workstep_call'},options:[]}})
 const render=(events:any[],active=true,running=true)=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome
  profile={profile} activity={null} projectId="p" projectName="默认工作区" sessionId="main"
  messages={[{id:'a',role:'assistant',content:'',status:running?'running':'succeeded',events}]} inputValue="" onDraft={()=>{}}
  running={running} active={active} onSend={async()=>true} onStop={async()=>true}><div data-transcript>审批对话</div></DigitalPersonHome></I18nProvider></MemoryRouter>)
 try{
  const answered=[request('old'),{type:'interaction_response',data:{interaction_id:'old',response:{action:'accept',content:{}}}}]
  await act(async()=>render(answered))
  assert.ok(host.querySelector('[data-transcript]') === null)
  await act(async()=>render([request('pending')],false))
  assert.ok(host.querySelector('[data-transcript]') === null)
  await act(async()=>render([request('pending')]))
  assert.ok(host.querySelector('[data-transcript]'),'authorization is visible without manually expanding chat')
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-chat header button')!.click())
  await act(async()=>render([request('pending')]))
  assert.ok(host.querySelector('[data-transcript]') === null, 'a dismissed request does not repeatedly force open')
  await act(async()=>render([request('next')]))
  assert.ok(host.querySelector('[data-transcript]'),'a new request becomes visible')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('identity setup greets one current question and preserves legacy greetings',async()=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 useLocaleStore.setState({locale:'zh-CN'})
 const render=(identity_setup:any)=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome
  profile={{...profile,identity_setup}} activity={null} projectId="p" projectName="默认工作区" sessionId="main" messages={[]}
  inputValue="" onDraft={()=>{}} running={false} active={false} onSend={async()=>true} onStop={async()=>true}
 /></I18nProvider></MemoryRouter>)
 try{
  for(const [answers,question] of [[{},'取什么名字'],[{name:'星河'},'什么角色'],[{name:'星河',role:'助手'},'说话语气'],[{name:'星河',role:'助手',personality:'直接'},'主要帮你做什么'],[{name:'星河',role:'助手',personality:'直接',duties:'研究'},'确认后再保存']] as const){
   await act(async()=>render({status:'pending',answers}))
   assert.ok(document.querySelector('.digital-home-reply')!.textContent!.includes(question))
  }
  for(const state of [undefined,{status:'completed',answers:{}},{status:'pending',paused:true,answers:{}}]){
   await act(async()=>render(state))
   assert.equal(document.querySelector('.digital-home-reply')!.textContent,profile.greeting)
  }
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('only an active local digital person page requests wake assets', async()=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 const oldLoad=wakeWordRuntime.load
 let preload=0
 wakeWordRuntime.load=async()=>({
  preloadWakeWord:async()=>{preload++;return new ArrayBuffer(0)},
  openWakeWord:async()=>{throw new Error('Visiting the page should not open the microphone')},
 })
 const render=(active:boolean)=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome
  profile={profile} activity={null} projectId="p" projectName="默认工作区" sessionId="main" messages={[]}
  inputValue="" onDraft={()=>{}} running={false} active={active} onSend={async()=>true} onStop={async()=>true}
 /></I18nProvider></MemoryRouter>)
 try {
  window.happyDOM.setURL('https://local.invalid/')
  await act(async()=>render(false))
  assert.equal(preload,0)
  assert.ok(!document.querySelector('.digital-presence-static'),'pending chat setup does not show the failure fallback')
  assert.ok(!document.querySelector('.digital-presence-particles'),'pending chat setup does not initialize WebGL')
  window.happyDOM.setURL('https://d-123.gateway.invalid/companion')
  await act(async()=>render(true))
  assert.equal(preload,0)
  window.happyDOM.setURL('https://local.invalid/companion')
  await act(async()=>render(true))
  assert.equal(preload,1)
 } finally {
  await act(async()=>root.unmount())
  wakeWordRuntime.load=oldLoad
  await window.happyDOM.close()
 }
})

test('gateway wake listening works with the speaker muted and rearms after a silent call', async context=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 window.happyDOM.setURL('https://d-123.gateway.invalid/companion')
 const originalSession=useGatewaySessionStore.getState().session
 const oldStatus=speechApi.status, oldLoad=wakeWordRuntime.load, oldCapture=voiceCapture.start
 let now=100
 context.mock.method(performance,'now',()=>now)
 useGatewaySessionStore.setState({session:{host_project_id:null} as GatewayRemoteSession})
 const get=voiceWakeApi.get
 voiceWakeApi.get=async()=>({keyword:'小研',sensitivity:'balanced',available:false,listening:false})
 speechApi.status=async()=>({enabled:true,ready:true}) as Awaited<ReturnType<typeof speechApi.status>>
 let loads=0
 let readyDetector=()=>{}
 const initializing=new Promise<void>(resolve=>{readyDetector=resolve})
 let readyMicrophone=()=>{}
 const openingMicrophone=new Promise<void>(resolve=>{readyMicrophone=resolve})
 let frame!: Parameters<typeof voiceCapture.start>[0]
 voiceCapture.start=async callback=>{frame=callback;await openingMicrophone;return {stop(){},flush(){}}}
 wakeWordRuntime.load=async()=>{
  loads++
  return {preloadWakeWord:async()=>new ArrayBuffer(0),openWakeWord:async()=>{
   await initializing
   return {matches:async()=>true,close(){}}
  }}
 }
 try {
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome
   profile={profile} activity={null} projectId="p" projectName="默认工作区" sessionId="main" messages={[]}
   inputValue="" onDraft={()=>{}} running={false} active onSend={async()=>true} onStop={async()=>true}
  /></I18nProvider></MemoryRouter>))
  const identity=document.querySelector<HTMLButtonElement>('.digital-home-identity')!
  const openWakeSwitch=async()=>{
   await act(async()=>identity.click())
   return document.querySelector<HTMLButtonElement>('.digital-home-detail-panel .wake-enabled-switch [role="switch"]')!
  }
  const closeIdentity=()=>act(async()=>document.querySelector<HTMLButtonElement>('.digital-home-detail-close')!.click())
  assert.ok(document.querySelector('.digital-person-listening') === null)
  const speaker=document.querySelector<HTMLButtonElement>('.digital-home-speaker')!
  await act(async()=>speaker.click())
  const wake=await openWakeSwitch()
  assert.equal(wake.getAttribute('aria-checked'),'false')
  assert.match(identity.textContent!,/待命/)
  assert.equal(loads,0)
  await act(async()=>wake.click())
  assert.equal(loads,1)
  assert.ok(document.querySelector('.digital-person-listening') === null)
  assert.doesNotMatch(identity.textContent!,/等待唤醒|Wake standby/)
  assert.doesNotMatch(document.querySelector('.digital-home-detail-state')!.textContent!,/等待唤醒|Wake standby/)
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(document.querySelector('.digital-home-end')?.getAttribute('data-action'),'phone')
  await act(async()=>readyDetector())
  assert.doesNotMatch(identity.textContent!,/等待唤醒|Wake standby/)
  await act(async()=>readyMicrophone())
  assert.match(identity.textContent!,/等待唤醒|Wake standby/)
  assert.match(document.querySelector('.digital-home-detail-state')!.textContent!,/等待唤醒|Wake standby/)
  await act(async()=>wake.click())
  assert.match(identity.textContent!,/待命/)
  await act(async()=>wake.click())
  await closeIdentity()
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(document.querySelector('.digital-home-end')?.getAttribute('data-action'),'hangup')
  assert.doesNotMatch(identity.textContent!,/等待唤醒|Wake standby/)
  assert.equal(speaker.getAttribute('aria-pressed'),'false')
  now+=60100
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,150))})
  assert.equal(document.querySelector('.digital-home-end')?.getAttribute('data-action'),'phone')
  assert.match(identity.textContent!,/等待唤醒|Wake standby/)
  await act(async()=>frame(Int16Array.of(1),0))
  const phone=document.querySelector<HTMLButtonElement>('.digital-home-end')!
  const microphone=document.querySelector<HTMLButtonElement>('.digital-home-microphone')!
  await act(async()=>microphone.click())
  assert.equal(phone.getAttribute('data-action'),'hangup')
  assert.match(identity.textContent!,/待命/)
  await act(async()=>phone.click())
  assert.match(identity.textContent!,/等待唤醒|Wake standby/)
  await act(async()=>document.querySelector<HTMLButtonElement>('.digital-home-dock-transcript')!.click())
  assert.match(identity.textContent!,/待命|Standby/)
  await act(async()=>window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape'})))
  assert.match(identity.textContent!,/等待唤醒|Wake standby/)
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'main',playing:true,level:.5}})))
  assert.match(identity.textContent!,/正在回应|Responding|Speaking/)
 } finally {
  await act(async()=>root.unmount())
  useGatewaySessionStore.setState({session:originalSession})
  speechApi.status=oldStatus;wakeWordRuntime.load=oldLoad;voiceCapture.start=oldCapture;voiceWakeApi.get=get
  await window.happyDOM.close()
 }
})

test('avatar home uses real conversation and delegated state, text view and return to workbench',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStatus=speechOutputApi.status;speechOutputApi.status=async()=>structuredClone(outputStatus)
 let path=''
 function Location(){path=useLocation().pathname;return null}
 try{
  await act(async()=>root.render(<MemoryRouter initialEntries={['/companion']}><I18nProvider><DigitalPersonHome profile={profile} activity={{delegations:[{id:'work',project_id:'p',session_id:'exec',instruction:'核验构建',status:'running'}]} as any} projectId="p" projectName="默认工作区" sessionId="main" messages={[{id:'u',role:'user',content:'帮我检查构建'},{id:'a',role:'assistant',content:'正在处理',status:'running'}]} inputValue="" onDraft={()=>{}} running active onSend={async()=>true} onStop={async()=>true}><div data-transcript>原有对话组件</div></DigitalPersonHome><Location/></I18nProvider></MemoryRouter>))
  assert.ok(host.querySelector('[data-affect-readonly],.digital-affect') === null)
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'thinking')
  assert.match(host.querySelector('.digital-home-work')!.textContent!,/核验构建/)
  assert.ok(host.querySelector('[data-transcript]') === null)
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'other',sessionId:'main',playing:true,level:1}})))
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'thinking')
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'main',playing:true,level:.6}})))
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'speaking')
  const dock=host.querySelector('.digital-home-voice-dock')!
  assert.deepEqual(Array.from(dock.querySelectorAll('button')).map(button=>button.hasAttribute('data-camera-toggle')?'camera':button.className.match(/digital-home-(speaker|microphone|end|keyboard)/)?.[1]),['camera','speaker','keyboard','microphone','end'])
  const keyboard=host.querySelector<HTMLButtonElement>('.digital-home-keyboard')!
  assert.equal(host.querySelectorAll('.digital-home-keyboard').length,1)
  assert.ok(keyboard.parentElement === dock)
  assert.ok(keyboard.getAttribute('aria-label'))
  assert.equal(keyboard.getAttribute('aria-haspopup'),'dialog')
  assert.equal(keyboard.getAttribute('aria-expanded'),'false')
  await act(async()=>keyboard.click())
  assert.equal(keyboard.getAttribute('aria-expanded'),'true')
  assert.ok(host.querySelector('[data-transcript]') === null)
  const dialog=document.querySelector('.digital-home-composer-dialog[role=dialog][aria-modal=true]')
  assert.ok(dialog?.querySelector('.digital-home-composer textarea'))
  assert.ok(!host.contains(dialog),'composer lives outside the presence layout')
  await act(async()=>window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  assert.ok(document.querySelector('.digital-home-composer-dialog') === null)
  assert.ok(document.activeElement === host.querySelector('.digital-home-keyboard'))
  assert.equal(keyboard.getAttribute('aria-expanded'),'false')
  assert.ok(host.querySelector('.digital-home-stage'))
  assert.ok(host.querySelector('.digital-home-voice-hint') === null)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-dock-transcript')!.click())
  assert.ok(host.querySelector('[data-transcript]'))
  assert.ok(document.querySelector('.digital-home-composer') === null)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-back')!.click())
  assert.equal(path,'/chat')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();speechOutputApi.status=oldStatus}
})

test('voice starts only by gesture, mute releases capture and hiding never restarts microphone',async context=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStatus=speechOutputApi.status,oldStart=voiceCapture.start,oldSpeech={...speechApi}
 const locale=useLocaleStore.getState().locale;useLocaleStore.setState({locale:'zh-CN'})
 let captures=0,stops=0,modelStops=0,grantMicrophone=()=>{}
 const microphonePermission=new Promise<void>(resolve=>{grantMicrophone=resolve})
 context.mock.timers.enable({apis:['setTimeout']})
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 voiceCapture.start=async()=>{if(++captures===1)await microphonePermission;return {stop:()=>stops++,flush:async()=>{}}}
 speechApi.start=async()=>({id:'voice',sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 const render=(running=false)=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome profile={profile} activity={null} projectId="p" projectName="默认工作区" sessionId="main" messages={[]} inputValue="" onDraft={()=>{}} running={running} active onSend={async()=>true} onStop={async()=>{modelStops++;return true}}/></I18nProvider></MemoryRouter>)
 try{
  await act(async()=>render())
  assert.equal(captures,0)
  const call=host.querySelector<HTMLButtonElement>('.digital-home-end')!
  assert.equal(call.disabled,false,'continuous conversation has its own idle entry')
  assert.equal(call.getAttribute('aria-label'),'开始连续对话')
  const microphone=host.querySelector<HTMLButtonElement>('.digital-home-microphone')!
  assert.equal(microphone.getAttribute('aria-label'),'麦克风')
  assert.equal(microphone.getAttribute('aria-description'),'开始语音输入')
  const micIcon=microphone.querySelector('.digital-home-mic-off')?.outerHTML
  assert.ok(micIcon)
  assert.ok(microphone.querySelector('.digital-home-mic-on') === null)
  const speaker=host.querySelector<HTMLButtonElement>('.digital-home-speaker')
  assert.ok(speaker, 'speaker control is available independently of capture')
  assert.equal(speaker.getAttribute('aria-pressed'),'true')
  assert.ok(speaker.querySelector('path[d="m2 2 20 20"]') === null)
  await act(async()=>speaker.click())
  assert.equal(speaker.getAttribute('aria-pressed'),'false')
  assert.ok(speaker.querySelector('path[d="m2 2 20 20"]'))
  assert.equal(speaker.getAttribute('aria-label'),'声音')
  assert.equal(speaker.title,'开启声音')
  assert.equal(captures,0)
  const controls=Array.from(host.querySelector('.digital-home-voice-dock')!.children)
  assert.equal(controls.length,5)
  assert.ok(controls[0].querySelector('[data-camera-toggle]'))
  assert.ok(controls[1].classList.contains('digital-home-speaker'))
  assert.ok(controls[2].classList.contains('digital-home-keyboard'))
  assert.ok(controls[3].classList.contains('digital-home-microphone'))
  assert.ok(controls[4] === call)
  await act(async()=>microphone.click())
  assert.equal(microphone.getAttribute('aria-busy'),'true')
  assert.equal(microphone.getAttribute('aria-pressed'),'false')
  assert.equal(microphone.querySelector('.digital-home-mic-off')?.outerHTML,micIcon)
  assert.ok(microphone.querySelector('.digital-home-mic-on') === null)
  await act(async()=>microphone.click())
  await act(async()=>context.mock.timers.tick(300))
  assert.ok(microphone.querySelector('.spinner'))
  await act(async()=>grantMicrophone())
  assert.equal(captures,1)
  assert.equal(microphone.getAttribute('aria-busy'),'false')
  assert.equal(host.querySelector<HTMLButtonElement>('.digital-home-end')!.disabled,false, 'started dialogue can be ended')
  assert.equal(host.querySelector('.digital-home-microphone')?.getAttribute('aria-pressed'),'true')
  assert.equal(microphone.getAttribute('aria-label'),'麦克风')
  assert.equal(microphone.getAttribute('aria-description'),'取消语音输入')
  assert.ok(microphone.querySelector('.digital-home-mic-on'))
  assert.ok(microphone.querySelector('.digital-home-mic-off') === null)
  const meter=host.querySelector('.digital-home-mic-fill')
  assert.equal(meter?.querySelector('svg')?.getAttribute('fill'),'currentColor','active capture shows the mic fill layer')
  assert.equal(meter?.getAttribute('aria-hidden'),'true')
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-microphone')!.click())
  assert.equal(captures,1);assert.ok(stops>0)
  assert.equal(microphone.querySelector('.digital-home-mic-off')?.outerHTML,micIcon)
  assert.ok(host.querySelector('.digital-home-mic-fill') === null)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-microphone')!.click())
  assert.equal(captures,2)
  Object.defineProperty(document,'hidden',{configurable:true,value:true})
  await act(async()=>document.dispatchEvent(new window.Event('visibilitychange')))
  assert.equal(host.querySelector('.digital-home-microphone')?.getAttribute('aria-pressed'),'false')
  Object.defineProperty(document,'hidden',{configurable:true,value:false})
  await act(async()=>document.dispatchEvent(new window.Event('visibilitychange')))
  assert.equal(captures,2)
  await act(async()=>call.click())
  assert.equal(captures,3);assert.equal(call.dataset.action,'hangup')
  assert.equal(call.getAttribute('aria-label'),'结束连续对话')
  const mic=host.querySelector<HTMLButtonElement>('.digital-home-microphone')!
  await act(async()=>render(true))
  assert.equal(call.dataset.action,'stop')
  assert.equal(mic.disabled,false,'the call microphone remains available while the model is running')
  const beforeMute=stops
  await act(async()=>mic.click())
  assert.equal(mic.getAttribute('aria-pressed'),'false')
  assert.equal(captures,3)
  assert.equal(stops,beforeMute+1)
  assert.equal(modelStops,0)
  assert.equal(call.dataset.action,'stop')
  await act(async()=>render())
  assert.equal(call.dataset.action,'hangup','muting keeps the phone call open')
  assert.equal(captures,3,'model completion does not restart the muted microphone')
  await act(async()=>mic.click())
  assert.equal(captures,4)
  assert.equal(mic.getAttribute('aria-pressed'),'true')
  const playback=(playing:boolean)=>act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{
   detail:{projectId:'p',sessionId:'main',playing,level:playing ? .6 : 0},
  })))
  await act(async()=>render(true))
  await playback(true)
  assert.equal(mic.getAttribute('aria-pressed'),'true','the call microphone keeps listening during playback')
  assert.equal(mic.disabled,false)
  await act(async()=>mic.click())
  assert.equal(captures,5,'explicitly reopening starts recognition during playback')
  assert.equal(mic.getAttribute('aria-pressed'),'true')
  await playback(false)
  assert.equal(call.dataset.action,'stop','the model is still running')
  assert.equal(modelStops,0)
  await act(async()=>mic.click())
  assert.equal(mic.getAttribute('aria-pressed'),'false')
  await act(async()=>mic.click())
  assert.equal(captures,6,'a muted call can also reopen the microphone during playback')
  await playback(false)
  await playback(true)
  assert.equal(mic.getAttribute('aria-pressed'),'true','the next playback keeps listening with echo filtering')
  await playback(false)
  await act(async()=>render())
  await act(async()=>call.click())
  assert.equal(call.dataset.action,'phone');assert.equal(captures,6)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();speechOutputApi.status=oldStatus;voiceCapture.start=oldStart;Object.assign(speechApi,oldSpeech);useLocaleStore.setState({locale})}
})

test('keyboard sends into same session and speaker enables sentence playback without global auto speak',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStatus=speechOutputApi.status,oldEnqueue=SpeechOutputPlayer.prototype.enqueue,oldStop=SpeechOutputPlayer.prototype.stop
 const spoken:string[]=[],sent:string[]=[]
 let stops=0
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 SpeechOutputPlayer.prototype.enqueue=function(sentences){spoken.push(...sentences)}
 SpeechOutputPlayer.prototype.stop=function(){stops++}
 let reply=(content:string,id?:string)=>{},showHome=(active:boolean)=>{}
 function App(){
  const [input,setInput]=useState(''),[messages,setMessages]=useState<any[]>([{id:'old',role:'assistant',content:'历史。',status:'succeeded'}])
  const [active,setActive]=useState(true)
  showHome=setActive
  reply=(content,id='new')=>setMessages([{id,role:'assistant',content,status:'running'}])
  return <MemoryRouter><I18nProvider><DigitalPersonHome profile={{...profile,auto_speak:false}} activity={null} projectId="p" projectName="默认工作区" sessionId="main" messages={messages} running={false} active={active} inputValue={input} onDraft={setInput} onSend={async text=>{sent.push(text);setInput('');reply('第一句。第二');return true}} onStop={async()=>true}/></I18nProvider></MemoryRouter>
 }
 try{
  await act(async()=>root.render(<App/>))
  assert.deepEqual(spoken,[])
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-keyboard')!.click())
  const input=document.querySelector<HTMLTextAreaElement>('.digital-home-composer textarea')!
  assert.ok(input)
  assert.ok(document.activeElement === input)
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'帮我看看');input.dispatchEvent(new window.Event('input',{bubbles:true}))})
  await act(async()=>document.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
  assert.deepEqual(sent,['帮我看看'])
  assert.deepEqual(spoken,['第一句。'])
  await act(async()=>reply('第一句。第二句！'))
  assert.deepEqual(spoken,['第一句。','第二句！'])
  const before=stops
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-dock-transcript')!.click())
  assert.equal(getProactiveSpeechContext()?.blockNew,true)
  await act(async()=>reply('第一句。第二句！第三句。'))
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-chat header button')!.click())
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-face-entry')!.click())
  await act(async()=>reply('第一句。第二句！第三句。第四句。'))
  await act(async()=>showHome(false))
  await act(async()=>reply('第一句。第二句！第三句。第四句。第五句。'))
  assert.equal(stops,before)
  assert.deepEqual(spoken,['第一句。','第二句！','第三句。','第四句。','第五句。'])
  await act(async()=>reply('页面外的新回复。','other'))
  await act(async()=>showHome(true))
  await act(async()=>reply('页面外的新回复。不补播。','other'))
  assert.equal(spoken.length,5)
  await act(async()=>reply('返回后的新回复。','visible'))
  const beforeMute=stops
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-speaker')!.click())
  assert.ok(stops>beforeMute)
  await act(async()=>reply('返回后的新回复。静音。','visible'))
  assert.equal(spoken.length,6)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();speechOutputApi.status=oldStatus;SpeechOutputPlayer.prototype.enqueue=oldEnqueue;SpeechOutputPlayer.prototype.stop=oldStop}
})

test('keyboard sends during audio-only playback and retains the draft until accepted',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStatus=speechOutputApi.status;speechOutputApi.status=async()=>structuredClone(outputStatus)
 let finish:(sent:boolean)=>void=()=>{},stops=0,blurs=0
 function App(){
  const [input,setInput]=useState(''),[running,setRunning]=useState(false)
  return <MemoryRouter><I18nProvider><DigitalPersonHome profile={profile} activity={null} projectId="p" projectName="p" sessionId="main" messages={[]} inputValue={input} onDraft={setInput} running={running} active onSend={async()=>{const sent=await new Promise<boolean>(resolve=>{finish=resolve});if(sent){setInput('');clearDraft('main','p');setRunning(true)}return sent}} onStop={async()=>{stops++;setRunning(false);return true}}/></I18nProvider></MemoryRouter>
 }
 try{
  await act(async()=>root.render(<App/>))
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'main',playing:true,level:.6}})))
  assert.equal(host.querySelector<HTMLButtonElement>('.digital-home-microphone')!.disabled,false)
  assert.equal(host.querySelector<HTMLButtonElement>('.digital-home-end')!.dataset.action,'phone')
  const keyboard=host.querySelector<HTMLButtonElement>('.digital-home-keyboard')!
  await act(async()=>keyboard.click())
  const input=document.querySelector<HTMLTextAreaElement>('.digital-home-composer textarea')!
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'帮我整理安排');input.dispatchEvent(new window.Event('input',{bubbles:true}))})
  const blur=input.blur.bind(input);input.blur=()=>{blurs++;blur()}
  await act(async()=>document.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
  assert.ok(document.querySelector('.digital-home-composer textarea') === input, 'pending send keeps input mounted')
  assert.equal(blurs,0)
  await act(async()=>finish(false))
  assert.ok(document.querySelector('.digital-home-composer textarea') === input)
  assert.equal(input.value,'帮我整理安排','failed send retains draft for retry')
  assert.equal(keyboard.getAttribute('aria-expanded'),'true')
  assert.equal(blurs,0,'failed send does not dismiss keyboard')
  await act(async()=>document.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
  await act(async()=>finish(true))
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'main',playing:false,level:0}})))
  assert.equal(blurs,1,'accepted send explicitly blurs before removing the textarea')
  assert.ok(document.querySelector('.digital-home-composer') === null)
  assert.equal(keyboard.getAttribute('aria-expanded'),'false')
  assert.ok(document.activeElement !== input)
  assert.equal(host.querySelector('.digital-home-microphone')?.getAttribute('aria-pressed'),'false')
  const stop=host.querySelector<HTMLButtonElement>('.digital-home-end')!
  assert.equal(stop.disabled,false)
  await act(async()=>stop.click());assert.equal(stops,1)
  await act(async()=>keyboard.click())
  const reopened=document.querySelector<HTMLTextAreaElement>('.digital-home-composer textarea')!
  assert.ok(reopened);assert.equal(reopened.value,'');assert.ok(document.activeElement === reopened)
 }finally{await act(async()=>root.unmount());speechOutputApi.status=oldStatus;await window.happyDOM.close()}
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
  assert.ok(host.querySelector('.digital-home-camera-perception') === null, 'preview has no face management footer')
  assert.ok(host.querySelector('.digital-home-face-entry'),'face management remains available in home controls')
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-dock-transcript')!.click())
  assert.ok(host.querySelector('[data-transcript]'));assert.equal(stops,0);assert.ok(host.querySelector('video') === video);assert.equal(video.srcObject,stream)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-chat header button')!.click())
  assert.equal(starts,1);assert.equal(stops,0);assert.equal(video.srcObject,stream)
  await act(async()=>root.unmount());assert.equal(stops,1)
 }finally{await act(async()=>root.unmount());speechOutputApi.status=oldStatus;await window.happyDOM.close()}
})

test('refresh restores media without resuming a call or sharing the mic with wake',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 window.happyDOM.setURL('https://local.invalid/companion')
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 const oldStatus=speechOutputApi.status,oldSpeechStatus=speechApi.status,oldCapture=voiceCapture.start,oldLoad=wakeWordRuntime.load,oldWake=voiceWakeApi.get
 let microphoneStarts=0,openMicrophones=0
 const cameraStarts:string[]=[]
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 speechApi.status=async()=>({enabled:true,ready:true}) as Awaited<ReturnType<typeof speechApi.status>>
 voiceWakeApi.get=async()=>({keyword:'小研',sensitivity:'balanced',available:false,listening:false})
 wakeWordRuntime.load=async()=>({
  preloadWakeWord:async()=>new ArrayBuffer(0),
  openWakeWord:async()=>({matches:async()=>false,close(){}}),
 })
 voiceCapture.start=async(_frame,signal)=>{
  assert.equal(openMicrophones,0,'wake and manual capture never acquire the microphone together')
  microphoneStarts++;openMicrophones++
  let stopped=false
  const stop=()=>{if(!stopped){stopped=true;openMicrophones--}}
  signal?.addEventListener('abort',stop,{once:true})
  return {stop,flush:async()=>{}}
 }
 const track={stop(){},addEventListener(){},readyState:'live'}
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async({video}:any)=>{
  cameraStarts.push(video.facingMode.ideal)
  return {getTracks:()=>[track],getVideoTracks:()=>[track]}
 }}})
 Object.defineProperty(window.HTMLVideoElement.prototype,'srcObject',{configurable:true,writable:true,value:null})
 window.HTMLVideoElement.prototype.play=async()=>{}
 const render=async(version:number)=>{
  await act(async()=>root.render(<StrictMode><MemoryRouter><I18nProvider><DigitalPersonHome key={version}
   profile={profile} activity={null} projectId="p" projectName="p" sessionId="main" messages={[]}
   inputValue="" onDraft={()=>{}} running={false} active onSend={async()=>true} onStop={async()=>true}
  /></I18nProvider></MemoryRouter></StrictMode>))
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))})
 }
 const button=(selector:string)=>host.querySelector<HTMLButtonElement>(selector)!
 const click=(selector:string)=>act(async()=>button(selector).click())
 const pressed=(selector:string)=>button(selector).getAttribute('aria-pressed')
 try{
  await render(0)
  assert.equal(microphoneStarts,0)
  await click('.digital-home-speaker')
  await click('[data-camera-toggle]')
  await click('.digital-person-camera-switch')
  await click('.digital-home-microphone')
  assert.deepEqual(cameraStarts,['environment','user'])
  assert.equal(microphoneStarts,1)
  await act(async()=>setWakeEnabled(true))
  assert.equal(microphoneStarts,1)
  await render(1)
  assert.equal(pressed('.digital-home-speaker'),'false')
  assert.equal(pressed('[data-camera-toggle]'),'true')
  assert.deepEqual(cameraStarts,['environment','user','user'])
  assert.equal(pressed('.digital-home-microphone'),'true')
  assert.equal(button('.digital-home-end').dataset.action,'phone')
  assert.equal(microphoneStarts,2,'refresh starts manual capture once, without opening wake capture')
  await click('.digital-home-microphone')
  assert.equal(pressed('.digital-home-microphone'),'false')
  assert.equal(microphoneStarts,3,'wake resumes after the manual mic closes')
  await click('[data-camera-toggle]')
  await click('.digital-home-end')
  assert.equal(button('.digital-home-end').dataset.action,'hangup')
  await render(2)
  assert.equal(button('.digital-home-end').dataset.action,'phone')
  assert.equal(pressed('.digital-home-microphone'),'false')
  assert.equal(pressed('[data-camera-toggle]'),'false')
  assert.equal(cameraStarts.length,3)
 }finally{
  await act(async()=>root.unmount())
  speechOutputApi.status=oldStatus;speechApi.status=oldSpeechStatus;voiceCapture.start=oldCapture;wakeWordRuntime.load=oldLoad;voiceWakeApi.get=oldWake
  await window.happyDOM.close()
 }
})


test('presence corner shows identity, affinity and the reflection count',async()=>{
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
  assert.match(corner.textContent!,/71/);assert.match(corner.querySelector('[aria-label="主动思考"]')?.textContent??'',/237/)
  assert.doesNotMatch(corner.textContent!,/真实会话作者|示例|执行次数/)
  assert.ok(host.querySelector('.digital-presence-orb'))
  assert.ok(host.querySelector('.digital-home-avatar img') === null)
  await act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'main',playing:true,level:.7}})))
  assert.match(corner.textContent!,/正在回应/)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=oldRecords;digitalAffectApi.read=oldAffect;speechOutputApi.status=oldStatus;await window.happyDOM.close()}
})

function mockVoice(callback:Parameters<typeof voiceCapture.start>[0], options?:Parameters<typeof voiceCapture.start>[4]) {
 let turn=new TurnController(options?.phoneCall)
 let end=0
 const emit=(probability:number,count=16)=>{
  for(let i=0;i<count;i++)turn.frame({end:end+=512,probability})
  const state=turn.snapshot()
  callback(new Int16Array(count*512),.4,state)
  if(options?.continuous&&state.canCommit)turn=new TurnController(options.phoneCall)
 }
 return {emit,capture:{stop(){},flush:async()=>turn.snapshot()}}
}

test('manual microphone leaves final text in the caption and sends only through the call action button',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStatus=speechOutputApi.status,oldSpeech={...speechApi},oldStart=voiceCapture.start
 let text='帮我检查',sent=0,frame!:ReturnType<typeof mockVoice>['emit']
 const submissions:string[]=[]
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 speechApi.start=async()=>({id:'live-preview',sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text})
 voiceCapture.start=async(callback,_token,_detect,_size,options)=>{
  const mock=mockVoice(callback,options);frame=mock.emit;return mock.capture
 }
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome profile={profile} activity={null} projectId="p" projectName="p" sessionId="live-preview" messages={[]} inputValue="" onDraft={()=>{}} running={false} active onSend={async content=>{sent++;submissions.push(content);return true}} onStop={async()=>true}/></I18nProvider></MemoryRouter>))
  const mic=host.querySelector<HTMLButtonElement>('.digital-home-microphone')!
  await act(async()=>mic.click())
  assert.ok(host.querySelector('.digital-home-live-caption'))
  await act(async()=>frame(.8))
  assert.match(host.querySelector('.digital-home-live-caption')!.textContent!,/帮我检查/)
  text='帮我检查一下今天的安排'
  await act(async()=>frame(.8))
  assert.match(host.querySelector('.digital-home-live-caption')!.textContent!,/帮我检查一下今天的安排/)
  assert.equal(sent,0,'partial recognition never submits a message')
  await act(async()=>frame(.02,19))
  assert.equal(host.querySelector('.digital-home-live-caption p')?.textContent,'帮我检查一下今天的安排')
  assert.ok(host.querySelector('textarea') === null)
  const action=host.querySelector<HTMLButtonElement>('.digital-home-end')!
  assert.equal(action.dataset.action,'send')
  assert.equal(sent,0,'final recognition stays in the caption')
  text='再看看明天的计划。'
  await act(async()=>frame(.8))
  assert.equal(host.querySelector('.digital-home-live-caption p')?.textContent,'帮我检查一下今天的安排 再看看明天的计划。','live text continues after the first pause')
  await act(async()=>frame(.02,19))
  assert.equal(sent,0,'additional phrases stay in the same draft')
  await act(async()=>action.click())
  assert.equal(sent,1)
  assert.deepEqual(submissions,['帮我检查一下今天的安排 再看看明天的计划。'])
  assert.equal(action.dataset.action,'phone')
  assert.equal(host.querySelector('.digital-home-microphone')?.getAttribute('aria-pressed'),'true')
  text='嗯嗯。'
  await act(async()=>frame(.8))
  await act(async()=>frame(.02,19))
  assert.equal(host.querySelector('.digital-home-live-caption p')?.textContent,'嗯嗯。')
  assert.equal(action.dataset.action,'send','manual mode lets the user decide whether to send a filler')
  const edit=host.querySelector<HTMLButtonElement>('.digital-home-live-caption-edit')!
  assert.ok(edit,'the recognized draft can be opened for editing')
  await act(async()=>edit.click())
  const editor=host.querySelector<HTMLTextAreaElement>('.digital-home-live-caption-editor')!
  assert.equal(editor.value,'嗯嗯。')
  assert.equal(mic.getAttribute('aria-pressed'),'false')
  await act(async()=>{
   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(editor,'')
   editor.dispatchEvent(new window.Event('input',{bubbles:true}))
  })
  assert.equal(action.disabled,true,'empty voice draft cannot be sent')
  await act(async()=>{
   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(editor,'确认，请继续。')
   editor.dispatchEvent(new window.Event('input',{bubbles:true}))
  })
  assert.equal(sent,1)
  await act(async()=>action.click())
  assert.equal(sent,2)
  assert.equal(submissions[1],'确认，请继续。')
  assert.equal(mic.getAttribute('aria-pressed'),'false','sending after turning the mic off keeps it off')
  assert.ok(host.querySelector('.digital-home-live-caption') === null)
  await act(async()=>mic.click())
  text='要清除的草稿'
  await act(async()=>frame(.8))
  await act(async()=>frame(.02,19))
  text='也要清除的临时识别'
  const discardedFrame=frame
  await act(async()=>frame(.8))
  const clear=host.querySelector<HTMLButtonElement>('.digital-home-live-caption-clear')!
  await act(async()=>clear.click())
  await act(async()=>discardedFrame(.02,19))
  assert.equal(host.querySelector('.digital-home-live-caption p')?.textContent??'','')
  assert.equal(action.dataset.action,'phone')
  assert.equal(mic.getAttribute('aria-pressed'),'true')
  assert.equal(sent,2)
  text='清除后重新识别'
  await act(async()=>frame(.8))
  await act(async()=>frame(.02,19))
  await act(async()=>mic.click())
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-live-caption-clear')!.click())
  assert.ok(host.querySelector('.digital-home-live-caption') === null)
  assert.equal(mic.getAttribute('aria-pressed'),'false')
  assert.equal(action.dataset.action,'phone')
 }finally{await act(async()=>root.unmount());speechOutputApi.status=oldStatus;Object.assign(speechApi,oldSpeech);voiceCapture.start=oldStart;await window.happyDOM.close()}
})


test('continuous voice queues recognized turns during execution and sends directly when idle',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStatus=speechOutputApi.status,oldSpeech={...speechApi},oldStart=voiceCapture.start
 const oldPending={...pendingMessageInsertApi}
 let sent:string[]=[],inserted:string[][]=[],frame!:ReturnType<typeof mockVoice>['emit'],captures=0,text='请检查移动端'
 pendingMessageInsertApi.list=async()=>({items:[]})
 pendingMessageInsertApi.create=async(project,target,content)=>{
  inserted.push([project,target,content])
  return {id:'voice-insert',target_message_id:target,content,position:0,username:'',created_at:'',updated_at:''}
 }
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 speechApi.start=async()=>({id:'home-supplement',sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text})
 voiceCapture.start=async(callback,_token,_detect,_frameSize,options)=>{
  captures++;const mock=mockVoice(callback,options);frame=mock.emit;return mock.capture
 }
 saveDraft('home-supplement','手写内容')
 function Harness({running,question}:{running:boolean;question?:string}){
  const [input,setInput]=useState('手写内容')
  return <MemoryRouter><I18nProvider><DigitalPersonHome profile={profile} activity={null} projectId="p" projectName="p" sessionId="home-supplement" messages={running?[{id:'voice-target',role:'assistant',status:'running',content:''}]:question?[{id:'question',role:'assistant',status:'succeeded',content:question}]:[]} inputValue={input} onDraft={setInput} running={running} active onSend={async content=>{sent.push(content);return true}} onStop={async()=>true}/></I18nProvider></MemoryRouter>
 }
 const say=async(value:string)=>{
  text=value
  await act(async()=>frame(.8))
  await act(async()=>frame(.02,57))
 }
 try{
  await act(async()=>root.render(<Harness running={false}/>))
  const call=host.querySelector<HTMLButtonElement>('.digital-home-end')!
  await act(async()=>call.click())
  await act(async()=>root.render(<Harness running/>))
  await act(async()=>frame(.8))
  assert.match(host.querySelector('.digital-home-live-caption')!.textContent!,/请检查移动端/)
  await act(async()=>frame(.02,25))
  assert.deepEqual(inserted,[],'a natural pause never enters the pending queue')
  await act(async()=>frame(.02,32))
  assert.deepEqual(sent,[],'generating replies queue the voice turn instead of dispatching it')
  assert.deepEqual(inserted,[['p','voice-target','请检查移动端']])
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-keyboard')!.click())
  const input=document.querySelector<HTMLTextAreaElement>('.digital-home-composer textarea')!
  assert.equal(input.value,'手写内容','voice turns never append to the typed draft')
  text='再检查桌面端'
  await act(async()=>frame(.8))
  await act(async()=>frame(.02,57))
  assert.deepEqual(inserted,[['p','voice-target','请检查移动端'],['p','voice-target','再检查桌面端']])
  assert.equal(input.value,'手写内容')
  assert.equal(captures,1);assert.equal(call.dataset.action,'stop')
  assert.ok(document.querySelector('.pending-insert-row'),'queued voice turns share the pending insert panel')
  await say('嗯，啊啊。')
  assert.equal(inserted.length,2,'standalone fillers never enter the pending queue')
  await act(async()=>root.render(<Harness running={false}/>))
  const output=(playing:boolean)=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'p',sessionId:'home-supplement',playing,level:0}}))
  let interrupted=0
  const stopPlayback=()=>{interrupted++;output(false)}
  window.addEventListener(STOP_DIGITAL_SPEECH,stopPlayback,{once:true})
  await act(async()=>output(true))
  assert.equal(call.dataset.action,'hangup','only playback remains after the model completes')
  const beforeBargeIn=captures
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-microphone')!.click())
  assert.equal(interrupted,1,'clicking the call microphone stops playback')
  assert.equal(captures,beforeBargeIn+1,'recognition opens immediately')
  assert.equal(call.dataset.action,'hangup')
  await say('呃……')
  assert.deepEqual(sent,[],'standalone fillers are ignored while idle too')
  await say('嗯，继续查一下')
  await say('停')
  assert.deepEqual(sent,['嗯，继续查一下','停'],'meaningful turns and short commands send after the silence threshold')
  assert.deepEqual(inserted,[['p','voice-target','请检查移动端'],['p','voice-target','再检查桌面端']])
  await act(async()=>root.render(<Harness running={false} question="你想先检查什么？"/>))
  await say('嗯。')
  assert.equal(sent.length,2,'an open question does not make a filler a confirmation')
  await act(async()=>root.render(<Harness running={false} question="移动端已经检查完了。**要继续吗？**"/>))
  await say('啊。')
  assert.equal(sent.length,2,'hesitation alone is not a confirmation')
  await say('嗯。')
  assert.deepEqual(sent,['嗯，继续查一下','停','嗯。'])
  assert.equal(call.dataset.action,'hangup')
  assert.equal(call.getAttribute('aria-pressed'),null)
 }finally{await act(async()=>root.unmount());speechOutputApi.status=oldStatus;Object.assign(speechApi,oldSpeech);Object.assign(pendingMessageInsertApi,oldPending);voiceCapture.start=oldStart;await window.happyDOM.close()}
})


test('atlas playback meters do not rerender the page for every volume sample',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldObserver=globalThis.ResizeObserver
 globalThis.ResizeObserver=class {observe(){}unobserve(){}disconnect(){}}
 let reads=0
 const meteredProfile={...profile,get name(){reads++;return '小研'}}
 const publish=(playing:boolean,level:number)=>act(async()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'meter-project',sessionId:'main',playing,level,metered:true}})))
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome profile={meteredProfile} activity={null} projectId="meter-project" projectName="默认工作区" sessionId="main" messages={[]} inputValue="" onDraft={()=>{}} running={false} active onSend={async()=>true} onStop={async()=>true}/></I18nProvider></MemoryRouter>))
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-atlas-toggle')!.click())
  assert.ok(host.querySelector('.memory-atlas'))
  await publish(true,.2)
  reads=0
  for(let i=1;i<=10;i++)await publish(true,i/10)
  assert.equal(reads,0,'amplitude changes must not rerender identity, history, camera and input')
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'speaking')
  await publish(false,0)
  assert.equal(host.querySelector('.digital-home')?.getAttribute('data-state'),'idle','playback transitions must still reach the page')
 }finally{await act(async()=>root.unmount());globalThis.ResizeObserver=oldObserver;await window.happyDOM.close()}
})


for(const call of [false,true])test(`hub silently ignores every speaker status while preserving microphone errors (${call})`,async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldSpeech={...speechApi},oldCapture=voiceCapture.start,oldOutput=speechOutputApi.status
 let frame!:ReturnType<typeof mockVoice>['emit'],speaker='unmatched'
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 speechApi.start=async()=>({id:'silent-speaker',sample_rate:16000,streaming:'native'})
 speechApi.cancel=async()=>({cancelled:true})
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text:'',speaker_status:speaker as any})
 voiceCapture.start=async(callback,_token,_detect,_size,options)=>{const mock=mockVoice(callback,options);frame=mock.emit;return mock.capture}
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHome profile={profile} activity={null} projectId="p" projectName="p" sessionId="silent-speaker" messages={[]} inputValue="" onDraft={()=>{}} running={false} active onSend={async()=>true} onStop={async()=>true}/></I18nProvider></MemoryRouter>))
  await act(async()=>host.querySelector<HTMLButtonElement>(call?'.digital-home-end':'.digital-home-microphone')!.click())
  for(speaker of ['unmatched','insufficient','invalidFeatures','needMoreSpeech','futureSpeakerFailure']){
   await act(async()=>frame(.9));await act(async()=>frame(.01,call?57:19))
   assert.equal(host.querySelectorAll('.voice-input-notice').length,0,speaker)
   assert.doesNotMatch(host.textContent!,/未匹配到你的声音|无法确认声纹|未取得有效声纹/)
  }
  if(call)await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-end')!.click())
  else await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-microphone')!.click())
  voiceCapture.start=async()=>{throw new DOMException('denied','NotAllowedError')}
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-microphone')!.click())
  assert.match(host.querySelector('.digital-home-error')?.textContent??'',/麦克风/)
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,oldSpeech);voiceCapture.start=oldCapture;speechOutputApi.status=oldOutput;await window.happyDOM.close()}
})
