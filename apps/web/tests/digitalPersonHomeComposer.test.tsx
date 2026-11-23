import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider} from '../src/i18n'
import {pendingMessageInsertApi} from '../src/api/client'
import {useAssistantPendingInserts} from '../src/hooks/useAssistantPendingInserts'
import {usePendingMessageInsertStore} from '../src/stores/pendingMessageInsertStore'
import {speechApi} from '../src/api/speech'
import {voiceCapture} from '../src/utils/voiceCapture'
import DigitalPersonHomeComposer from '../src/components/digital-person/DigitalPersonHomeComposer'

test('running mobile dictation stays in the draft until submitted to the conversation queue',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 Object.assign(globalThis,{history:window.history})
 window.innerWidth=390
 const original={...speechApi},pending={...pendingMessageInsertApi},start=voiceCapture.start
 let frame!:Parameters<typeof voiceCapture.start>[0],sends=0
 const queued:string[][]=[]
 pendingMessageInsertApi.list=async()=>({items:[]})
 pendingMessageInsertApi.create=async(project,target,content)=>{
  queued.push([project,target,content])
  return {id:'insert',target_message_id:target,content,position:0,username:'',created_at:'',updated_at:''}
 }
 speechApi.status=async()=>({enabled:true,ready:true}) as any
 speechApi.start=async()=>({id:'supplement',sample_rate:16000,streaming:'native'}) as any
 speechApi.cancel=async()=>({cancelled:true}) as any
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text:'语音补充内容'})
 voiceCapture.start=async callback=>{frame=callback;return {stop(){},flush:async()=>{}}}
 function ComposerWithQueue({running,shown,value,onChange}:{running:boolean;shown:boolean;value:string;onChange:(value:string)=>void}){
  const messages=[{id:'reply',role:'assistant' as const,content:'',status:running?'running' as const:'succeeded' as const}]
  const pending=useAssistantPendingInserts({projectId:'p',sessionId:'dictation',messages,input:value,onInputChange:onChange,onSendContent:async()=>true})
  return <DigitalPersonHomeComposer projectId="p" sessionId="dictation" shown={shown} onClose={()=>{}} active running={running}
   messages={messages} value={value} onChange={onChange} onSend={async()=>true} onSendPending={async()=>true} onStop={()=>{}}
   pendingPanel={pending.panel} pendingError={pending.error} queueEnabled={pending.queueEnabled} queueCurrentInput={pending.queueCurrentInput}/>
 }
 function Harness({running=true,shown=true}){
  const [value,setValue]=useState('')
  return <MemoryRouter><I18nProvider><ComposerWithQueue running={running} shown={shown} value={value} onChange={setValue}/></I18nProvider></MemoryRouter>
 }
 usePendingMessageInsertStore.setState({queues:{},loaded:{},loading:{}})
 try{
  await act(async()=>root.render(<Harness/>))
  const mic=document.querySelector<HTMLButtonElement>('.voice-microphone')
  assert.ok(mic)
  assert.equal(mic.disabled,false)
  await act(async()=>mic.click())
  assert.equal(document.querySelector('.chat-input-send')?.getAttribute('data-state'),'stopped')
  await act(async()=>frame(new Int16Array(8000).fill(5000),.4,{
   lastVoice:8000,hasSpeech:true,recentSpeech:true,candidate:false,canCommit:false,
  }))
  await act(async()=>document.querySelector<HTMLButtonElement>('.voice-input-secondary-actions button:last-child')!.click())
  assert.equal(document.querySelector('textarea')!.value,'语音补充内容')
  assert.deepEqual(queued,[])
  await act(async()=>document.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
  assert.deepEqual(queued,[['p','reply','语音补充内容']])
  assert.equal(document.querySelector('textarea')!.value,'')
  await act(async()=>root.render(<Harness shown={false}/>))
  assert.ok(document.querySelector('.pending-insert-panel'))
  await act(async()=>root.render(<Harness running={false} shown={false}/>))
  assert.equal(document.querySelector('.pending-insert-panel'),null)
  assert.equal(sends,0,'the frontend does not dispatch a duplicate turn on completion')
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);Object.assign(pendingMessageInsertApi,pending);voiceCapture.start=start;await window.happyDOM.close()}
})
