import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {installDomEnvironment} from './helpers/domEnv'
import Player from '../src/components/digital-person/DigitalPersonProactiveSpeech'
import {dispatchProactiveMessage,playFaceWelcome,setProactiveSpeechContext} from '../src/components/digital-person/digitalPersonProactive'
import {digitalPersonApi} from '../src/api/digitalPerson'
import {speechOutputApi} from '../src/api/speechOutput'
import {SpeechOutputPlayer} from '../src/utils/speechOutput'
import {outputStatus} from './fixtures/speechOutput'

test('live proactive speech plays once and suppresses muted, hidden and disabled events',async()=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 const old={get:digitalPersonApi.get,status:speechOutputApi.status,enqueue:SpeechOutputPlayer.prototype.enqueue,stop:SpeechOutputPlayer.prototype.stop}
 let focus=true,hidden=false,enabled=true,automatic=true,stops=0
 document.hasFocus=()=>focus
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden})
 const profile=()=>({enabled,name:'助手',role:'',personality:'',duties:'',avatar:'robot' as const,greeting:'',auto_speak:automatic})
 digitalPersonApi.get=async()=>profile();speechOutputApi.status=async()=>structuredClone(outputStatus)
 const spoken:string[]=[]
 SpeechOutputPlayer.prototype.enqueue=function(sentences){spoken.push(...sentences)}
 SpeechOutputPlayer.prototype.stop=function(){stops++}
 const send=(id:string)=>act(async()=>{dispatchProactiveMessage({type:'CUSTOM',name:'digital_person.proactive_message',channel:'digital_person',project_id:'owner-home',session_id:'main',value:{message_id:id,text:'主动说的话。'}});await new Promise(r=>setTimeout(r,0))})
 try{
  await act(async()=>root.render(<Player/>));assert.deepEqual(spoken,[])
  await send('outside');assert.deepEqual(spoken,[],'ordinary chat must not auto speak')
  const context=()=>({projectId:'owner-home',sessionId:'main',profile:profile(),muted:false})
  setProactiveSpeechContext(context())
  await send('one');await send('one');assert.equal(spoken.length,1)
  focus=false;await send('background');focus=true;await send('background')
  assert.equal(spoken.length,2,'a visible client may speak while another app has focus')
  automatic=false;setProactiveSpeechContext(context());await send('off');automatic=true
  setProactiveSpeechContext({projectId:'owner-home',sessionId:'main',profile:profile(),muted:true})
  await send('muted');setProactiveSpeechContext(null);await send('muted')
  enabled=false;setProactiveSpeechContext(context());await send('disabled');enabled=true;setProactiveSpeechContext(context())
  hidden=true;await send('hidden');hidden=false;await send('hidden');assert.equal(spoken.length,2)
  await send('two');assert.equal(spoken.length,3)
  let before=stops
  setProactiveSpeechContext({...context(),blockNew:true})
  await send('while-blocked')
  assert.equal(stops,before,'blocking new proactive messages preserves the current playback')
  setProactiveSpeechContext(context());await send('while-blocked');assert.equal(spoken.length,3)
  setProactiveSpeechContext(null);assert.ok(stops>before,'releasing the playback scope stops playback');await send('outside-again');assert.equal(spoken.length,3)
  setProactiveSpeechContext(context());await send('three')
  before=stops;setProactiveSpeechContext({projectId:'owner-home',sessionId:'main',profile:profile(),muted:true});assert.ok(stops>before)
 }finally{
  await act(async()=>root.unmount());setProactiveSpeechContext(null);digitalPersonApi.get=old.get;speechOutputApi.status=old.status
  SpeechOutputPlayer.prototype.enqueue=old.enqueue;SpeechOutputPlayer.prototype.stop=old.stop;await window.happyDOM.close()
 }
})


test('leaving avatar while output settings load prevents delayed proactive playback',async()=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 const oldStatus=speechOutputApi.status,oldEnqueue=SpeechOutputPlayer.prototype.enqueue
 let resolve!:(value:any)=>void
 speechOutputApi.status=()=>new Promise(done=>{resolve=done})
 const spoken:string[]=[]
 SpeechOutputPlayer.prototype.enqueue=function(sentences){spoken.push(...sentences)}
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 try{
  setProactiveSpeechContext({projectId:'race-home',sessionId:'main',profile:{enabled:true,auto_speak:true} as any,muted:false})
  await act(async()=>root.render(<Player/>))
  await act(async()=>dispatchProactiveMessage({type:'CUSTOM',name:'digital_person.proactive_message',channel:'digital_person',project_id:'race-home',session_id:'main',value:{message_id:'pending',text:'不应迟到播放。'}}))
  assert.equal(typeof resolve,'function')
  setProactiveSpeechContext(null)
  await act(async()=>{resolve(structuredClone(outputStatus));await new Promise(r=>setTimeout(r,0))})
  assert.deepEqual(spoken,[])
 }finally{
  await act(async()=>root.unmount());setProactiveSpeechContext(null);speechOutputApi.status=oldStatus;SpeechOutputPlayer.prototype.enqueue=oldEnqueue;await window.happyDOM.close()
 }
})

test('face welcome keeps template identity out of non-local speech',async()=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 const oldStatus=speechOutputApi.status,oldEnqueue=SpeechOutputPlayer.prototype.enqueue
 const spoken:string[]=[]
 speechOutputApi.status=async(projectId)=>({...outputStatus,settings:{...outputStatus.settings,mode:projectId==='local-voice'?'local':'cloud'}})
 SpeechOutputPlayer.prototype.enqueue=function(sentences){spoken.push(...sentences)}
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 try{
  await act(async()=>root.render(<Player/>))
  for(const projectId of ['cloud-voice','local-voice']){
   setProactiveSpeechContext({projectId,sessionId:'main',profile:{enabled:true,auto_speak:true} as any,muted:false})
   await act(async()=>{
    playFaceWelcome({projectId,sessionId:'main',messageId:projectId,text:'小林，欢迎回来。',privateSpeechFallback:'欢迎回来。'})
    await new Promise(resolve=>setTimeout(resolve,0))
   })
  }
  assert.deepEqual(spoken,['欢迎回来。','小林，欢迎回来。'])
 }finally{
  await act(async()=>root.unmount());setProactiveSpeechContext(null)
  speechOutputApi.status=oldStatus;SpeechOutputPlayer.prototype.enqueue=oldEnqueue;await window.happyDOM.close()
 }
})
