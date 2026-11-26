import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act, createRef} from 'react'
import {I18nProvider} from '../src/i18n'
import DigitalPersonWake, {wakeWordRuntime, type WakeControls} from '../src/components/digital-person/DigitalPersonWake'
import {VOICE_WAKE_CHANGED,voiceWakeApi} from '../src/api/digitalPerson'
import {createRoot} from 'react-dom/client'
import {useDigitalPersonDialogue} from '../src/components/digital-person/useDigitalPersonDialogue'
import {speechApi} from '../src/api/speech'
import {speechOutputApi} from '../src/api/speechOutput'
import {outputStatus} from './fixtures/speechOutput'
import {voiceCapture} from '../src/utils/voiceCapture'
import {TurnController,type TurnState} from '../src/audio/turnController'
import {setWakeEnabled} from '../src/components/digital-person/wakePreferences'

const checkpoints = new WeakMap<Parameters<typeof voiceCapture.start>[0],TurnState>()
function samples(frame: Parameters<typeof voiceCapture.start>[0], options?: Parameters<typeof voiceCapture.start>[4]) {
 let end=0
 let turn=new TurnController(options?.phoneCall)
 return (count:number, probability:number)=>{
  for(let i=0;i<count;i++)turn.frame({end:end+=512,probability})
  const state=turn.snapshot();checkpoints.set(frame,state)
  frame(new Int16Array(count*512).fill(probability>=.8?1000:0),0,state)
  if(options?.continuous&&state.canCommit)turn=new TurnController(options.phoneCall)
 }
}

test('phone turns survive natural pauses and keep capturing while final recognition is pending',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...speechApi},start=voiceCapture.start,descriptor=Object.getOwnPropertyDescriptor(performance,'now')
 let now=100,captures=0,sessions=0,finishRecognition:()=>void=()=>{}
 let emit!:ReturnType<typeof samples>
 const segments:string[]=[]
 const finalRequests:string[]=[]
 Object.defineProperty(performance,'now',{configurable:true,value:()=>now})
 speechApi.start=async()=>({id:`turn-${++sessions}`,sample_rate:16000,streaming:'segment'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 speechApi.audio=async(id,_p,sequence,audio,final)=>{
  if(final){
   finalRequests.push(id)
   if(id==='turn-2'){
    const pcm=Buffer.from(audio,'base64')
    let voicedSamples=0
    for(let i=0;i<pcm.length;i+=2)if(pcm.readInt16LE(i)===1000)voicedSamples++
    assert.equal(voicedSamples,1024,'the next turn includes both short onset frames')
   }
   await new Promise<void>(resolve=>{finishRecognition=resolve})
  }
  return {id,sequence,final,text:id==='turn-2'?'好':final?'检查构建和测试':'检查构建'}
 }
 voiceCapture.start=async(callback,_token,_detect,_frameSize,options)=>{
  captures++;emit=samples(callback,options)
  return {stop(){},flush:async()=>checkpoints.get(callback)}
 }
 function Harness({running=false,speaking=false}){const d=useDigitalPersonDialogue({projectId:'p',sessionId:'turn',active:true,running,speaking,onRecognized:text=>segments.push(text),onStop:async()=>true});return <><button aria-pressed={d.continuous} onClick={d.startContinuous}>call</button><button onClick={d.end}>end</button><span>{d.text}</span></>}
 const render=(running=false,speaking=false)=>act(async()=>root.render(<Harness running={running} speaking={speaking}/>))
 try{
  await render();await act(async()=>host.querySelector('button')!.click())
  await act(async()=>{emit(1,.9);emit(57,.05)})
  assert.equal(sessions,0,'an isolated noise spike does not start recognition')
  await act(async()=>{emit(16,.9);emit(30,.05)})
  assert.deepEqual(finalRequests,[],'960 ms of silence must not request a final result')
  assert.equal(host.querySelector('span')!.textContent,'检查构建')
  assert.deepEqual(segments,[])
  await act(async()=>{
   for(let i=0;i<16;i++)emit(16,.9)
   emit(56,.05)
  })
  assert.deepEqual(segments,[])
  await act(async()=>emit(1,.05))
  assert.deepEqual(finalRequests,['turn-1'])
  await act(async()=>{emit(2,.9);emit(57,.05)})
  assert.equal(sessions,1,'a slow final result must not lose the next utterance')
  await act(async()=>finishRecognition())
  assert.deepEqual(segments,['检查构建和测试'])
  await render(true)
  assert.equal(sessions,2)
  await act(async()=>finishRecognition())
  assert.deepEqual(segments,['检查构建和测试','好'])
  assert.equal(captures,1)
  assert.equal(host.querySelector('button')!.getAttribute('aria-pressed'),'true')
  await act(async()=>{emit(2,.9);emit(57,.05)})
  await act(async()=>host.querySelectorAll('button')[1].click())
  await act(async()=>finishRecognition())
  assert.deepEqual(segments,['检查构建和测试','好'],'hangup invalidates a pending final result')
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=start;if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete (performance as any).now;await window.happyDOM.close()}
})

for(const [streaming,firstFrames] of [['native',10],['segment',38]] as const){
 test(`phone ${streaming} previews uninterrupted speech before the first pause`,async()=>{
  const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  const original={...speechApi},start=voiceCapture.start
  let emit!:ReturnType<typeof samples>
  const requests:{preview:boolean;final:boolean}[]=[]
  const messages:string[]=[]
  voiceCapture.start=async(callback,_token,_detect,_frameSize,options)=>{
   emit=samples(callback,options)
   return {stop(){},flush:async()=>checkpoints.get(callback)}
  }
  speechApi.start=async()=>({id:'uninterrupted',sample_rate:16000,max_seconds:120,streaming})
  speechApi.cancel=async()=>({cancelled:true})
  speechApi.audio=async(id,_project,sequence,_audio,final,_signal,preview=true)=>{
   requests.push({preview,final})
   return {id,sequence,final,text:final?'请检查构建结果':'请检查'}
  }
  function Harness(){
   const d=useDigitalPersonDialogue({projectId:'p',sessionId:'uninterrupted',active:true,running:false,speaking:false,
    onRecognized:text=>messages.push(text),onStop:async()=>true})
   return <><button onClick={d.startContinuous}>call</button><span>{d.text}</span></>
  }
  try{
   await act(async()=>root.render(<Harness/>))
   await act(async()=>host.querySelector('button')!.click())
   await act(async()=>emit(firstFrames-1,.9))
   assert.deepEqual(requests,[])
   await act(async()=>emit(1,.9))
   assert.deepEqual(requests,[{preview:true,final:false}])
   assert.equal(host.querySelector('span')!.textContent,'请检查')
   await act(async()=>emit(24,.9))
   if(streaming==='segment')assert.equal(requests.length,1,'a segment model does not repeatedly decode the growing prefix')
   assert.deepEqual(messages,[])
   await act(async()=>emit(57,.05))
   assert.deepEqual(messages,['请检查构建结果'])
  }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=start;await window.happyDOM.close()}
 })
}

test('manual microphone keeps listening and preserves unsent segments across send results',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...speechApi},start=voiceCapture.start
 let captures=0,autoSends=0,text='帮我检查一下',emit!:ReturnType<typeof samples>
 let releaseFirst:()=>void=()=>{}
 let acceptSend:(accepted:boolean)=>void=()=>{}
 const submissions:string[]=[]
 speechApi.start=async()=>({id:`manual-${captures}`,sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 speechApi.audio=async(id,_p,sequence,_audio,final)=>{
  const result={id,sequence,final,text}
  if(final&&text==='帮我检查一下')await new Promise<void>(resolve=>{releaseFirst=resolve})
  return result
 }
 voiceCapture.start=async(callback,_token,_detect,_size,options)=>{
  captures++;emit=samples(callback,options)
  return {stop(){},flush:async()=>checkpoints.get(callback)}
 }
 function Harness(){
  const d=useDigitalPersonDialogue({projectId:'p',sessionId:'manual',active:true,running:false,speaking:false,
   onRecognized:()=>{autoSends++},onSendDraft:content=>{submissions.push(content);return new Promise(resolve=>{acceptSend=resolve})},onStop:async()=>true})
  return <button onClick={d.draft===null?d.toggle:d.sendDraft}>{d.draft??'mic'}</button>
 }
 try{
  await act(async()=>root.render(<Harness/>))
  const button=host.querySelector('button')!
  await act(async()=>button.click())
  assert.equal(captures,1)
  await act(async()=>{emit(16,.9);emit(19,.05)})
  text='再检查明天的计划'
  await act(async()=>emit(16,.9))
  await act(async()=>releaseFirst())
  assert.equal(button.textContent,'帮我检查一下')
  assert.equal(captures,1)
  assert.deepEqual(submissions,[]);assert.equal(autoSends,0)
  await act(async()=>button.click())
  await act(async()=>acceptSend(false))
  assert.equal(button.textContent,'帮我检查一下');assert.equal(captures,1)
  await act(async()=>button.click())
  await act(async()=>emit(19,.05))
  assert.equal(button.textContent,'帮我检查一下 再检查明天的计划')
  await act(async()=>acceptSend(true))
  assert.deepEqual(submissions,['帮我检查一下','帮我检查一下'])
  assert.equal(button.textContent,'再检查明天的计划');assert.equal(captures,1)
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=start;await window.happyDOM.close()}
})

test('an active manual microphone tries once to reopen after the device track ends',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const start=voiceCapture.start,Controller=globalThis.AbortController
 globalThis.AbortController=window.AbortController as unknown as typeof AbortController
 let captures=0,signal!:AbortSignal,revoked=false
 voiceCapture.start=async (_callback,token)=>{
  captures++;signal=token
  if(revoked)throw new DOMException('Permission revoked','NotAllowedError')
  return {stop(){},flush(){}}
 }
 function Harness(){
  const d=useDigitalPersonDialogue({projectId:'p',sessionId:'restart',active:true,running:false,speaking:false,
   onRecognized:()=>{},onStop:async()=>true})
  return <><button onClick={d.toggle}>mic</button><span>{d.error}</span></>
 }
 try{
  await act(async()=>root.render(<Harness/>))
  await act(async()=>host.querySelector('button')!.click())
  await act(async()=>{signal.dispatchEvent(new Event('error'))})
  assert.equal(captures,2);assert.equal(host.querySelector('span')!.textContent,'')
  await act(async()=>{signal.dispatchEvent(new Event('error'))})
  assert.equal(captures,2);assert.equal(host.querySelector('span')!.textContent,'speech.deviceLost')
  await act(async()=>host.querySelector('button')!.click())
  assert.equal(captures,3);assert.equal(host.querySelector('span')!.textContent,'')
  revoked=true
  await act(async()=>{signal.dispatchEvent(new Event('error'))})
  assert.equal(captures,4);assert.equal(host.querySelector('span')!.textContent,'speech.permissionDenied')
  revoked=false
  await act(async()=>host.querySelector('button')!.click())
  assert.equal(captures,5);assert.equal(host.querySelector('span')!.textContent,'')
 }finally{await act(async()=>root.unmount());globalThis.AbortController=Controller;voiceCapture.start=start;await window.happyDOM.close()}
})

test('pagehide ends the call even when it precedes visibilitychange',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const start=voiceCapture.start
 let captures=0,stopped=0
 voiceCapture.start=async()=>{captures++;return {stop(){stopped++},flush(){}}}
 function Harness(){
  const d=useDigitalPersonDialogue({projectId:'p',sessionId:'cached-page',active:true,running:false,speaking:false,
   onRecognized:()=>assert.fail('unexpected transcript'),onStop:async()=>true})
  return <button onClick={d.startContinuous} aria-pressed={d.continuous}>call</button>
 }
 try{
  await act(async()=>root.render(<Harness/>))
  const call=host.querySelector('button')!
  await act(async()=>call.click())
  assert.equal(captures,1)
  assert.equal(document.hidden,false)
  await act(async()=>window.dispatchEvent(new window.Event('pagehide')))
  assert.equal(call.getAttribute('aria-pressed'),'false')
  assert.equal(stopped,1)
  await act(async()=>window.dispatchEvent(new window.Event('pageshow')))
  assert.equal(captures,1)
  await act(async()=>call.click())
  assert.equal(captures,2)
 }finally{await act(async()=>root.unmount());voiceCapture.start=start;await window.happyDOM.close()}
})

for(const streaming of ['native','segment'] as const)test(`phone ${streaming} interrupts playback without restarting capture or submitting echo`,async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStart=voiceCapture.start,oldSpeech={...speechApi}
 let captures=0,disposed=0,stops=0,interrupts=0,text='今天北京天气晴朗'
 let emit!:ReturnType<typeof samples>
 const messages:string[]=[]
 speechApi.start=async()=>({id:'v',sample_rate:16000,streaming}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text})
 voiceCapture.start=async(callback,_t,_d,_s,options)=>{captures++;emit=samples(callback,options);return {stop:()=>disposed++,flush:async()=>checkpoints.get(callback)}}
 const interrupted=()=>{interrupts++}
 window.addEventListener('workstep:digital-person-stop-speech',interrupted)
 function Harness({running=false,speaking=false}){
  const voice=useDigitalPersonDialogue({projectId:'p',sessionId:'s',active:true,running,speaking,playbackText:'今天北京天气晴朗，适合出门。',onRecognized:value=>messages.push(value),onStop:async()=>{stops++;return true}})
  return <><button onClick={voice.startContinuous}>call</button><button onClick={voice.toggle}>mic</button><button onClick={voice.stopReply}>stop</button><span data-in-call={voice.continuous}>{voice.phase}</span></>
 }
 const render=(running=false,speaking=false)=>act(async()=>root.render(<Harness running={running} speaking={speaking}/>))
 try{
  await render();await act(async()=>host.querySelector('button')!.click())
  await render(true,true)
  const baseline=interrupts
  assert.equal(disposed,0,'playback keeps capture open')
  await act(async()=>emit(10,.9))
  assert.equal(interrupts,baseline,'preview matching playback cannot interrupt')
  // End playback before the final ASR reply: context must remain on this segment.
  await render()
  await act(async()=>emit(57,.05))
  assert.deepEqual(messages,[],'late playback echo is never delivered')
  await render(true,true);text='停止'
  await act(async()=>emit(10,.9))
  assert.equal(interrupts,baseline+1,'user preview stops playback before endpoint')
  assert.deepEqual(messages,[],'preview itself does not submit')
  await render(true,false)
  await act(async()=>emit(57,.05))
  assert.deepEqual(messages,['停止'])
  assert.equal(captures,1,'the call and microphone are retained')
  assert.equal(host.querySelector('span')?.getAttribute('data-in-call'),'true')
  await render(true,true)
  await act(async()=>host.querySelectorAll('button')[1].click())
  assert.equal(interrupts,baseline+2,'microphone click also interrupts during a running reply')
  assert.equal(disposed,1,'explicit interruption discards buffered playback audio')
  await act(async()=>host.querySelectorAll('button')[2].click())
  assert.equal(stops,1,'the stop square retains its existing reply stop behavior')
 }finally{window.removeEventListener('workstep:digital-person-stop-speech',interrupted);await act(async()=>root.unmount());voiceCapture.start=oldStart;Object.assign(speechApi,oldSpeech);await window.happyDOM.close()}
})

for(const streaming of ['native','segment'] as const)test(`phone ${streaming} retains an unfinished thought across endpoints and fillers`,async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStart=voiceCapture.start,oldSpeech={...speechApi}
 let emit!:ReturnType<typeof samples>,text='我想',captures=0
 const messages:string[]=[]
 speechApi.start=async()=>({id:'thought',sample_rate:16000,streaming}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text})
 voiceCapture.start=async(callback,_t,_d,_s,options)=>{captures++;emit=samples(callback,options);return {stop(){},flush:async()=>checkpoints.get(callback)}}
 function Harness(){
  const voice=useDigitalPersonDialogue({projectId:'p',sessionId:'thought',active:true,running:false,speaking:false,onRecognized:value=>messages.push(value),onStop:async()=>true})
  return <><button onClick={voice.startContinuous}>call</button><button onClick={voice.end}>end</button><span>{voice.text}</span></>
 }
 const say=async(value:string)=>{text=value;await act(async()=>emit(16,.9));await act(async()=>emit(57,.02))}
 try{
  await act(async()=>root.render(<Harness/>));await act(async()=>host.querySelector('button')!.click())
  await say('我想')
  assert.deepEqual(messages,[],'an acoustic endpoint is not sufficient to submit a fragment')
  assert.equal(host.querySelector('span')!.textContent,'我想','the unfinished thought remains visible')
  await say('嗯')
  assert.deepEqual(messages,[],'filler does not finish or erase the thought')
  await say('查一下明天北京的天气')
  assert.deepEqual(messages,['我想 查一下明天北京的天气'])
  await say('停')
  assert.deepEqual(messages,['我想 查一下明天北京的天气','停'],'useful one-character commands remain automatic')
  await say('我想')
  await act(async()=>host.querySelectorAll('button')[1].click())
  await act(async()=>host.querySelector('button')!.click())
  await say('取消')
  assert.equal(messages.at(-1),'取消','hangup clears the previous call fragment')
  assert.equal(captures,2)
 }finally{await act(async()=>root.unmount());voiceCapture.start=oldStart;Object.assign(speechApi,oldSpeech);await window.happyDOM.close()}
})

for(const wakeCall of [false,true])test(wakeCall?'a wake-started call hangs up after one minute of silence':'a manually started call mutes after fifteen seconds of silence',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...speechApi},start=voiceCapture.start,descriptor=Object.getOwnPropertyDescriptor(performance,'now')
 let now=100,captures=0,cancelled=0,sends=0
 Object.defineProperty(performance,'now',{configurable:true,value:()=>now})
 speechApi.start=async()=>({id:'idle',sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 voiceCapture.start=async()=>{captures++;return {stop:()=>cancelled++,flush:async()=>{}}}
 function Harness(){const d=useDigitalPersonDialogue({projectId:'p',sessionId:'idle',active:true,running:false,speaking:false,onRecognized:()=>{sends++},onStop:async()=>true});return <button data-continuous={d.continuous} aria-pressed={d.connected&&!d.muted} onClick={wakeCall?d.startWakeContinuous:d.startContinuous}>call</button>}
 try{
  await act(async()=>root.render(<Harness/>));await act(async()=>host.querySelector('button')!.click())
  assert.equal(captures,1)
  if(wakeCall){
   now=60099;await act(async()=>{await new Promise(resolve=>setTimeout(resolve,150))})
   assert.equal(host.querySelector('button')!.getAttribute('aria-pressed'),'true')
  }
  now=wakeCall?60100:15200;await act(async()=>{await new Promise(resolve=>setTimeout(resolve,150))})
  assert.equal(host.querySelector('button')!.getAttribute('aria-pressed'),'false')
  assert.equal(host.querySelector('button')!.getAttribute('data-continuous'),String(!wakeCall))
  assert.ok(cancelled>0);assert.equal(sends,0);assert.equal(captures,1)
  await act(async()=>host.querySelector('button')!.click())
  assert.equal(captures,2,'a matched wake word reopens the short conversation')
  assert.equal(host.querySelector('button')!.getAttribute('aria-pressed'),'true')
  assert.equal(sends,0,'wake word itself is never sent as a user request')
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=start;if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete (performance as any).now;await window.happyDOM.close()}
})


test('local wake listening uses keyword detection and hands over without transcribing standby audio', async context => {
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const speech={...speechApi},start=voiceCapture.start,get=voiceWakeApi.get,audio=voiceWakeApi.audio,load=wakeWordRuntime.load
 const output=speechOutputApi.status
 const originalAudio=globalThis.Audio
 let audioCreated=0
 let sound: InstanceType<typeof window.EventTarget> | undefined
 globalThis.Audio=class extends window.EventTarget {
  constructor(){super();audioCreated++}
  async play(){sound=this}
  pause(){}
  removeAttribute(){}
 } as unknown as typeof Audio
 let preloads=0, captures=0, opened=0, closed=0, hits=0, transcriptions=0
 let frame!:Parameters<typeof voiceCapture.start>[0], signal!:AbortSignal
 speechApi.status=async()=>({enabled:true,ready:true}) as Awaited<ReturnType<typeof speechApi.status>>
 speechApi.start=async()=>{transcriptions++;throw new Error('Wake audio must not reach ASR')}
 let feedback={greeting:'',sound_enabled:true}
 const wake=createRef<WakeControls>()
 voiceWakeApi.get=async()=>({keyword:'你好小研',sensitivity:'balanced',available:false,listening:false,...feedback})
 voiceWakeApi.audio=async()=>({status:'system',text:feedback.greeting})
 wakeWordRuntime.load=async()=>({
  preloadWakeWord:async()=>{preloads++;return new ArrayBuffer(0)},
  openWakeWord:async(_config,token)=>{
   opened++
   token.addEventListener('abort',()=>{closed++},{once:true})
   return {matches:async pcm=>pcm[0]===1,reset:async()=>{},close(){}}
  },
 })
 voiceCapture.start=async(callback,token)=>{captures++;frame=callback;signal=token;return {stop(){},flush(){}}}
 const greetingStates:boolean[]=[]
 const onGreetingChange=(value:boolean)=>greetingStates.push(value)
 const render=(blocked:boolean,playback=false)=>root.render(<I18nProvider><DigitalPersonWake ref={wake} projectId="wake-test" blocked={blocked} playback={playback} onWake={()=>{hits++}} onGreetingChange={onGreetingChange}/></I18nProvider>)
 try {
  await act(async()=>render(false))
  assert.equal(preloads,1)
  assert.equal(captures,0,'preloading does not open the microphone')
  assert.equal(host.childElementCount,0,'automatic listening has no toolbar')
  await act(async()=>setWakeEnabled(true))
  assert.equal(captures,1)
  assert.equal(audioCreated,1,'the chime is prepared during standby')
  await act(async()=>frame(Int16Array.of(0),0))
  assert.equal(hits,0)
  await act(async()=>render(true))
  assert.equal(signal.aborted,true,'busy playback releases the microphone')
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(hits,0)
  await act(async()=>render(false))
  assert.equal(captures,2)
  assert.equal(opened,1,'resuming after busy playback reuses the ready detector')
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(hits,0,'conversation waits for the sound to finish')
  assert.deepEqual(greetingStates,[true])
  assert.ok(sound)
  assert.equal(signal.aborted,true,'wake detection releases the microphone before the sound')
  await act(async()=>sound!.dispatchEvent(new window.Event('ended')))
  assert.equal(hits,1)
  assert.deepEqual(greetingStates,[true,false])
  assert.ok(host.querySelector('[role=switch]') === null)
  const previousSound=sound
  const nativeCalls:{type:string;id:string;text?:string}[]=[]
  const bridge:NonNullable<Window['WorkStepSpeech']>={onmessage:null,
   postMessage:(message:string)=>nativeCalls.push(JSON.parse(message))}
  window.WorkStepSpeech=bridge
  speechOutputApi.status=async()=>({...outputStatus,settings:{...outputStatus.settings,mode:'system'}})
  feedback.greeting='我在，您说 |  | 有何贵干'
  context.mock.method(Math,'random',()=>.99)
  await act(async()=>window.dispatchEvent(new window.Event(VOICE_WAKE_CHANGED)))
  await act(async()=>render(true))
  await act(async()=>render(false))
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(nativeCalls[0]?.text,'有何贵干')
  assert.equal(sound,previousSound,'the greeting replaces the chime')
  assert.equal(hits,1)
  const capturesDuringGreeting=captures
  assert.equal(wake.current!.releaseMicrophone(),false,'manual microphone controls cannot interrupt the greeting')
  await act(async()=>render(false,true))
  assert.deepEqual(nativeCalls.map(call=>call.type),['speak'],'a competing output frame does not cancel the greeting')
  assert.equal(captures,capturesDuringGreeting)
  await act(async()=>bridge.onmessage?.({data:JSON.stringify({id:nativeCalls[0].id,status:'done'})}))
  assert.equal(hits,2)
  await act(async()=>render(false,false))
  await act(async()=>new Promise(resolve=>setTimeout(resolve,620)))
  assert.equal(wake.current!.releaseMicrophone(),true)
  voiceWakeApi.audio=async()=>({status:'pending',text:feedback.greeting})
  await act(async()=>window.dispatchEvent(new window.Event(VOICE_WAKE_CHANGED)))
  await act(async()=>render(true))
  await act(async()=>render(false))
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(nativeCalls[1]?.text,'有何贵干','a pending cache still plays the selected greeting')
  assert.equal(hits,2)
  await act(async()=>bridge.onmessage?.({data:JSON.stringify({id:nativeCalls[1].id,status:'done'})}))
  assert.equal(hits,3)
  feedback.sound_enabled=false
  await act(async()=>window.dispatchEvent(new window.Event(VOICE_WAKE_CHANGED)))
  await act(async()=>render(true))
  await act(async()=>render(false))
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(sound,previousSound,'disabled wake sound does not play')
  assert.equal(nativeCalls.length,2,'disabled wake sound skips the greeting')
  assert.equal(hits,4)
  feedback.greeting=''
  await act(async()=>window.dispatchEvent(new window.Event(VOICE_WAKE_CHANGED)))
  await act(async()=>render(true))
  await act(async()=>render(false))
  sound=undefined
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(sound,undefined,'disabled wake sound with an empty greeting also skips the default chime')
  assert.equal(hits,5)
  assert.equal(closed,4)
  assert.equal(transcriptions,0)
 }finally{
  await act(async()=>root.unmount())
  window.localStorage.removeItem('workstep.digital-person.wake-enabled')
  window.localStorage.removeItem('workstep.digital-person.wake-sound')
  speechOutputApi.status=output
  delete window.WorkStepSpeech
  Object.assign(speechApi,speech);voiceCapture.start=start;voiceWakeApi.get=get;voiceWakeApi.audio=audio;wakeWordRuntime.load=load
  globalThis.Audio=originalAudio
  await window.happyDOM.close()
 }
})
