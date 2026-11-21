import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {chatSessionApi} from '../src/api/conversations'
import {useChatSessionRead} from '../src/hooks/useChatSessionRead'

test('receipts require visible focused active conversation and a completed displayed message',async()=>{
 const {window}=installDomEnvironment();const node=document.body.appendChild(document.createElement('div')),root=createRoot(node)
 let visible=false,focused=false;const calls:string[]=[]
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visible?'visible':'hidden'})
 document.hasFocus=()=>focused
 const original=chatSessionApi.markRead
 chatSessionApi.markRead=async(s,p,m)=>{calls.push(`${p}/${s}/${m}`);return {read:true}}
 function Surface({active=true,ready=true,status='running',id='m'}:{active?:boolean;ready?:boolean;status?:string;id?:string}){
  useChatSessionRead('p','s',[{id,role:'assistant',status}],active,ready);return <p>{id}</p>
 }
 try{
  await act(async()=>root.render(<Surface/>));assert.equal(calls.length,0)
  visible=true;focused=true
  await act(async()=>root.render(<Surface status="completed" active={false}/>));assert.equal(calls.length,0)
  await act(async()=>root.render(<Surface status="completed" ready={false}/>));assert.equal(calls.length,0)
  await act(async()=>root.render(<Surface status="completed"/>));assert.deepEqual(calls,['p/s/m'])
  await act(async()=>{window.dispatchEvent(new window.Event('focus'));document.dispatchEvent(new window.Event('visibilitychange'))});assert.equal(calls.length,1)
  visible=false
  await act(async()=>root.render(<Surface status="completed" id="new"/>));assert.equal(calls.length,1)
  visible=true;focused=false
  await act(async()=>document.dispatchEvent(new window.Event('visibilitychange')));assert.equal(calls.length,1)
  focused=true
  await act(async()=>window.dispatchEvent(new window.Event('focus')));assert.deepEqual(calls,['p/s/m','p/s/new'])
 }finally{await act(async()=>root.unmount());chatSessionApi.markRead=original;node.remove();await window.happyDOM.close()}
})


test('an open delegation only acknowledges its own result once it becomes terminal',async()=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.hasFocus=()=>true
 const original=chatSessionApi.markRead,calls:string[]=[],read:string[]=[]
 chatSessionApi.markRead=async(_s,_p,id)=>{calls.push(id);return {read:true}}
 const target={messageId:'result',onResultVisible:(status:string)=>read.push(status)}
 function Surface({status,ready}:{status:string;ready:boolean}){
  useChatSessionRead('p','s',[{id:'result',role:'assistant',status},{id:'other',role:'assistant',status:'completed'}],true,ready,target)
  return null
 }
 try{
  await act(async()=>root.render(<Surface status="running" ready/>));assert.deepEqual(calls,[])
  await act(async()=>root.render(<Surface status="completed" ready={false}/>));assert.deepEqual(calls,[])
  await act(async()=>root.render(<Surface status="completed" ready/>));assert.deepEqual(calls,['result']);assert.deepEqual(read,['completed'])
 }finally{await act(async()=>root.unmount());chatSessionApi.markRead=original;await window.happyDOM.close()}
})
