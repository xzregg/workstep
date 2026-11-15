import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider} from '../src/i18n'
import {DigitalPersonWakeController} from '../src/components/digital-person/DigitalPersonWake'
import {digitalPersonApi} from '../src/api/digitalPerson'
import {useProjectStore} from '../src/stores/projectStore'
import {createRoot} from 'react-dom/client'
import {useDigitalPersonDialogue} from '../src/components/digital-person/useDigitalPersonDialogue'
import {speechApi} from '../src/api/speech'
import {useWakeState} from '../src/components/digital-person/digitalPersonWakeState'
import {voiceCapture} from '../src/utils/voiceCapture'

test('thinking and playback suspend voice capture without stopping the engine, then resume after a cooldown',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldStart=voiceCapture.start,oldSpeech={...speechApi}
 let captures=0,disposed=0,stops=0,sends=0,late:((samples:Int16Array,level:number)=>void)|undefined
 speechApi.start=async()=>({id:'v',sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 voiceCapture.start=async callback=>{captures++;late=callback;return {stop:()=>disposed++,flush:async()=>{}}}
 function Harness({running=false,speaking=false}){
  const voice=useDigitalPersonDialogue({projectId:'p',sessionId:'s',active:true,running,speaking,onSend:async()=>{sends++;return true},onStop:async()=>{stops++;return true}})
  return <><button onClick={voice.toggle}>microphone</button><button onClick={voice.end}>end</button><span>{voice.phase}</span></>
 }
 const render=(running=false,speaking=false)=>act(async()=>root.render(<Harness running={running} speaking={speaking}/>))
 try{
  await render();await act(async()=>host.querySelector('button')!.click());assert.equal(captures,1)
  const oldFrame=late!;await render(true)
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
  assert.equal(stops,1,'explicit end remains able to stop the running turn')
 }finally{await act(async()=>root.unmount());voiceCapture.start=oldStart;Object.assign(speechApi,oldSpeech);await window.happyDOM.close()}
})

test('an idle conversation times out instead of accepting perpetual room audio',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...speechApi},start=voiceCapture.start,descriptor=Object.getOwnPropertyDescriptor(performance,'now')
 let now=100,captures=0,cancelled=0,sends=0
 Object.defineProperty(performance,'now',{configurable:true,value:()=>now})
 speechApi.start=async()=>({id:'idle',sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 voiceCapture.start=async()=>{captures++;return {stop:()=>cancelled++,flush:async()=>{}}}
 function Harness(){const d=useDigitalPersonDialogue({projectId:'p',sessionId:'idle',active:true,running:false,speaking:false,onSend:async()=>{sends++;return true},onStop:async()=>true});return <button aria-pressed={d.connected&&!d.muted} onClick={d.toggle}>mic</button>}
 try{
  await act(async()=>root.render(<Harness/>));await act(async()=>host.querySelector('button')!.click())
  useWakeState.setState({keyword:'你好小研',sensitivity:'balanced',listening:false})
  assert.equal(captures,1)
  now=15200;await act(async()=>{await new Promise(resolve=>setTimeout(resolve,150))})
  assert.equal(host.querySelector('button')!.getAttribute('aria-pressed'),'false')
  assert.ok(cancelled>0);assert.equal(sends,0);assert.equal(captures,1)
  assert.equal(useWakeState.getState().listening,true,'timeout returns to keyword listening')
  await act(async()=>useWakeState.setState({listening:false,activationPending:true}))
  assert.equal(captures,2,'a matched wake word reopens the short conversation')
  assert.equal(host.querySelector('button')!.getAttribute('aria-pressed'),'true')
  assert.equal(sends,0,'wake word itself is never sent as a user request')
 }finally{await act(async()=>root.unmount());useWakeState.setState({listening:false,activationPending:false,keyword:''});Object.assign(speechApi,original);voiceCapture.start=start;if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete (performance as any).now;await window.happyDOM.close()}
})


test('wake controller ignores ordinary text and activates conversation only after a matching keyword',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...speechApi},start=voiceCapture.start,getProfile=digitalPersonApi.get,projects=useProjectStore.getState().projects
 let captures=0,sends=0,text='外面的普通聊天',frame!:(pcm:Int16Array,level:number)=>void
 speechApi.start=async()=>({id:`wake-${captures}`,sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text})
 digitalPersonApi.get=async()=>({enabled:true}) as any
 voiceCapture.start=async callback=>{captures++;frame=callback;return {stop(){},flush:async()=>{}}}
 useProjectStore.setState({projects:[{id:'p',name:'home',is_default_workspace:true,type:'local'} as any]})
 useWakeState.setState({listening:true,activationPending:false,keyword:'你好小研',sensitivity:'balanced',error:''})
 function Harness(){const d=useDigitalPersonDialogue({projectId:'p',sessionId:'wake',active:true,running:false,speaking:false,onSend:async()=>{sends++;return true},onStop:async()=>true});return <><span data-connected={d.connected&&!d.muted}/><button onClick={d.end}>end</button></>}
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonWakeController/><Harness/></I18nProvider></MemoryRouter>))
  assert.equal(captures,1)
  await act(async()=>frame(new Int16Array(8000),.2))
  assert.equal(host.querySelector('span[data-connected]')!.getAttribute('data-connected'),'false')
  assert.equal(sends,0)
  text='你好小研'
  await act(async()=>frame(new Int16Array(8000),.2))
  assert.equal(useWakeState.getState().listening,false)
  assert.equal(host.querySelector('span[data-connected]')!.getAttribute('data-connected'),'true')
  assert.equal(captures,2)
  assert.equal(sends,0)
  await act(async()=>host.querySelector('button')!.click())
  assert.equal(useWakeState.getState().listening,false)
 }finally{await act(async()=>root.unmount());useWakeState.setState({listening:false,activationPending:false,keyword:''});useProjectStore.setState({projects});Object.assign(speechApi,original);voiceCapture.start=start;digitalPersonApi.get=getProfile;await window.happyDOM.close()}
})
