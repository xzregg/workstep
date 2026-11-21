import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {I18nProvider} from '../src/i18n'
import DigitalPersonWake, {wakeWordRuntime} from '../src/components/digital-person/DigitalPersonWake'
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
function samples(frame: Parameters<typeof voiceCapture.start>[0]) {
 let end=0
 const turn=new TurnController()
 return (count:number, probability:number)=>{
  for(let i=0;i<count;i++)turn.frame({end:end+=512,probability})
  const state=turn.snapshot();checkpoints.set(frame,state)
  frame(new Int16Array(count*512),0,state)
 }
}

test('continuous input finalizes segments without sending and rearms during generation',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...speechApi},start=voiceCapture.start,descriptor=Object.getOwnPropertyDescriptor(performance,'now')
 let now=100,captures=0,frame!:Parameters<typeof voiceCapture.start>[0]
 const segments:string[]=[]
 Object.defineProperty(performance,'now',{configurable:true,value:()=>now})
 speechApi.start=async()=>({id:`turn-${captures}`,sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text:'检查构建'})
 voiceCapture.start=async callback=>{captures++;frame=callback;return {stop(){},flush:async()=>checkpoints.get(callback)}}
 function Harness({running=false,speaking=false}){const d=useDigitalPersonDialogue({projectId:'p',sessionId:'turn',active:true,running,speaking,onRecognized:text=>segments.push(text),onStop:async()=>true});return <button aria-pressed={d.continuous} onClick={d.startContinuous}>call</button>}
 const render=(running=false,speaking=false)=>act(async()=>root.render(<Harness running={running} speaking={speaking}/>))
 try{
  await render();await act(async()=>host.querySelector('button')!.click())
  let emit=samples(frame)
  await act(async()=>{emit(16,.9);emit(18,.05)})
  assert.deepEqual(segments,[])
  await act(async()=>emit(1,.05))
  assert.deepEqual(segments,['检查构建']);assert.equal(captures,2)
  await render(true);assert.equal(captures,2)
  emit=samples(frame)
  await act(async()=>{emit(16,.9);emit(19,.05)})
  assert.deepEqual(segments,['检查构建','检查构建']);assert.equal(captures,3)
  assert.equal(host.querySelector('button')!.getAttribute('aria-pressed'),'true')
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=start;if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete (performance as any).now;await window.happyDOM.close()}
})

test('manual microphone keeps listening and preserves unsent segments across send results',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...speechApi},start=voiceCapture.start
 let captures=0,autoSends=0,text='帮我检查一下',frame!:Parameters<typeof voiceCapture.start>[0]
 let acceptSend:(accepted:boolean)=>void=()=>{}
 const submissions:string[]=[]
 speechApi.start=async()=>({id:`manual-${captures}`,sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text})
 voiceCapture.start=async callback=>{captures++;frame=callback;return {stop(){},flush:async()=>checkpoints.get(callback)}}
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
  await act(async()=>{const emit=samples(frame);emit(16,.9);emit(19,.05)})
  assert.equal(button.textContent,'帮我检查一下')
  assert.equal(captures,2)
  assert.deepEqual(submissions,[]);assert.equal(autoSends,0)
  await act(async()=>button.click())
  await act(async()=>acceptSend(false))
  assert.equal(button.textContent,'帮我检查一下');assert.equal(captures,2)
  await act(async()=>button.click())
  text='再检查明天的计划'
  await act(async()=>{const emit=samples(frame);emit(16,.9);emit(19,.05)})
  assert.equal(button.textContent,'帮我检查一下 再检查明天的计划')
  await act(async()=>acceptSend(true))
  assert.deepEqual(submissions,['帮我检查一下','帮我检查一下'])
  assert.equal(button.textContent,'再检查明天的计划');assert.equal(captures,3)
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=start;await window.happyDOM.close()}
})

test('an active manual microphone tries once to reopen after the device track ends',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const start=voiceCapture.start,Controller=globalThis.AbortController
 globalThis.AbortController=window.AbortController as unknown as typeof AbortController
 let captures=0,signal!:AbortSignal
 voiceCapture.start=async (_callback,token)=>{captures++;signal=token;return {stop(){},flush(){}}}
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
 }finally{await act(async()=>root.unmount());globalThis.AbortController=Controller;voiceCapture.start=start;await window.happyDOM.close()}
})

test('continuous conversation keeps capture during thinking but protects against playback echo',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStart=voiceCapture.start,oldSpeech={...speechApi}
 let captures=0,disposed=0,stops=0,sends=0,late:((samples:Int16Array,level:number)=>void)|undefined
 speechApi.start=async()=>({id:'v',sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 voiceCapture.start=async callback=>{captures++;late=callback;return {stop:()=>disposed++,flush:async()=>{}}}
 function Harness({running=false,speaking=false}){
  const voice=useDigitalPersonDialogue({projectId:'p',sessionId:'s',active:true,running,speaking,onRecognized:()=>{sends++},onStop:async()=>{stops++;return true}})
  return <><button onClick={voice.startContinuous}>call</button><button onClick={voice.stopReply}>stop</button><span data-in-call={voice.continuous}>{voice.phase}</span></>
 }
 const render=(running=false,speaking=false)=>act(async()=>root.render(<Harness running={running} speaking={speaking}/>))
 try{
  await render();await act(async()=>host.querySelector('button')!.click());assert.equal(captures,1)
  const oldFrame=late!;await render(true)
  assert.equal(disposed,0)
  await render(true,true)
  assert.ok(disposed>0)
  await act(async()=>{oldFrame(new Int16Array(8000),.6);oldFrame(new Int16Array(8000),.6)})
  assert.equal(stops,0);assert.equal(sends,0);assert.equal(captures,1)
  await render(false,true);assert.equal(captures,1)
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,650))})
  assert.equal(captures,1,'long playback stays protected')
  await render();assert.equal(captures,1,'no immediate echo recapture')
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,750))})
  assert.equal(captures,2)
  await render(true)
  await act(async()=>host.querySelectorAll('button')[1].click())
  assert.equal(stops,1,'the stop square interrupts the reply')
  assert.equal(host.querySelector('span')?.getAttribute('data-in-call'),'true','stopping a reply keeps the call open')
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


test('local wake listening uses keyword detection and hands over without transcribing standby audio', async () => {
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
 const render=(blocked:boolean)=>root.render(<I18nProvider><DigitalPersonWake projectId="wake-test" blocked={blocked} onWake={()=>{hits++}}/></I18nProvider>)
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
  assert.ok(sound)
  assert.equal(signal.aborted,true,'wake detection releases the microphone before the sound')
  await act(async()=>sound!.dispatchEvent(new window.Event('ended')))
  assert.equal(hits,1)
  assert.equal(host.querySelector('[role=switch]'),null)
  const previousSound=sound
  const nativeCalls:{type:string;id:string;text?:string}[]=[]
  const bridge:NonNullable<Window['WorkStepSpeech']>={onmessage:null,
   postMessage:(message:string)=>nativeCalls.push(JSON.parse(message))}
  window.WorkStepSpeech=bridge
  speechOutputApi.status=async()=>({...outputStatus,settings:{...outputStatus.settings,mode:'system'}})
  feedback.greeting='我在，您说'
  await act(async()=>window.dispatchEvent(new window.Event(VOICE_WAKE_CHANGED)))
  await act(async()=>render(true))
  await act(async()=>render(false))
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(nativeCalls[0]?.text,'我在，您说')
  assert.equal(sound,previousSound,'the greeting replaces the chime')
  assert.equal(hits,1)
  await act(async()=>bridge.onmessage?.({data:JSON.stringify({id:nativeCalls[0].id,status:'done'})}))
  assert.equal(hits,2)
  feedback.sound_enabled=false
  await act(async()=>window.dispatchEvent(new window.Event(VOICE_WAKE_CHANGED)))
  await act(async()=>render(true))
  await act(async()=>render(false))
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(sound,previousSound,'disabled wake sound does not play')
  assert.equal(nativeCalls.length,1,'disabled wake sound skips the greeting')
  assert.equal(hits,3)
  feedback.greeting=''
  await act(async()=>window.dispatchEvent(new window.Event(VOICE_WAKE_CHANGED)))
  await act(async()=>render(true))
  await act(async()=>render(false))
  sound=undefined
  await act(async()=>frame(Int16Array.of(1),0))
  assert.equal(sound,undefined,'disabled wake sound with an empty greeting also skips the default chime')
  assert.equal(hits,4)
  assert.equal(closed,3)
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
