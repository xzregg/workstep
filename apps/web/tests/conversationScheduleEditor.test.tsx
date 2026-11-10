import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ConversationScheduleEditor from '../src/components/ConversationScheduleEditor'
import { scheduleApi } from '../src/api/schedule'
import { chatSessionApi } from '../src/api/conversations'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('conversation timer validates, follows channel and saves only the selected session', async () => {
 const { window }=installDomEnvironment();useLocaleStore.setState({locale:'zh-CN'})
 const original={...scheduleApi}, list=chatSessionApi.list
 useChatListStore.setState({sessionsByProject:{},listLoadingByProject:{},listErrorByProject:{}})
 chatSessionApi.list=async()=>({sessions:[{id:'s',title:'研发群',source:'channel',channel_name:'研发机器人',channel_platform:'dingtalk',channel_peer_name:'研发群'}]}) as any
 scheduleApi.preview=async()=>({next_runs:['2026-11-10T10:00:00Z'],summary:'',timezone:'UTC',cron_expression:null})
 let payload:any,dirty=false
 scheduleApi.create=async(_id,value)=>{payload=value;return {...value,id:'rule'} as any}
 const root=createRoot(document.body.appendChild(document.createElement('div')))
 const set=async(selector:string,value:string)=>act(async()=>{const input=document.querySelector(selector) as HTMLInputElement;const proto=input.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:input.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(input,value);input.dispatchEvent(new window.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}))})
 try{
  await act(async()=>root.render(<I18nProvider><ConversationScheduleEditor projectId="p" schedule={null} onSaved={()=>{}} onEditorStateChange={s=>{dirty=s.dirty}} /></I18nProvider>))
  assert.equal(document.querySelector<HTMLButtonElement>('[data-save-session-schedule]')!.disabled,true)
  await set('[aria-label="标题"]','检查进展');await set('[aria-label="关联对话"]','s');await set('textarea','检查最新情况')
  await act(async()=>new Promise(resolve=>setTimeout(resolve,280)))
  assert.match(document.body.textContent!,/研发机器人/);assert.match(document.body.textContent!,/自动回传/);assert.equal(dirty,true)
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-save-session-schedule]')!.click())
  assert.equal(payload.target_type,'session');assert.equal(payload.target_session_id,'s');assert.equal(payload.instruction,'检查最新情况');assert.equal(payload.notification,undefined);assert.deepEqual(payload.task_template,{})
 }finally{await act(async()=>root.unmount());Object.assign(scheduleApi,original);chatSessionApi.list=list;await window.happyDOM.close()}
})
