/** Isolated UI fixture: actual production components, synthetic records and APIs. */
import React,{useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {BrowserRouter} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../../../src/i18n'
import AssistantChatPanel from '../../../src/components/AssistantChatPanel'
import DigitalPersonWorkspace from '../../../src/components/digital-person/DigitalPersonWorkspace'
import DigitalPersonFeedback from '../../../src/components/digital-person/DigitalPersonFeedback'
import DigitalPersonSettings from '../../../src/components/digital-person/DigitalPersonSettings'
import {digitalPersonApi,digitalRuntimeApi,voiceWakeApi,type DigitalActivity,type DigitalPersonProfile} from '../../../src/api/digitalPerson'
import {speechApi} from '../../../src/api/speech'
import {useProjectStore} from '../../../src/stores/projectStore'
import {useWakeState} from '../../../src/components/digital-person/digitalPersonWakeState'
import type {AssistantChatMessage} from '../../../src/stores/assistantStore'
import '../../../src/index.css'
import '../../../src/mobile.css'
import './preview.css'

const now='2026-11-12T14:50:00Z'
let profile:DigitalPersonProfile={enabled:true,name:'小研',role:'研发协作伙伴',personality:'简洁、可靠',duties:'指派任务，跟进结果',avatar:'robot' as const,greeting:'今天有什么需要一起推进？',proactive_enabled:true,proactive_interval_minutes:30}
let activity:DigitalActivity={feedback:{},suggestions:[],experience:45,level:3,next_level_experience:90,session_count:12,reply_count:44,task_count:8,completed_task_count:5,skills:[{id:'review',name:'代码评审'},{id:'workflow',name:'工作流设计'},{id:'long',name:'项目构建异常分析与自动化验证'}],checking:false,answers:[],
 delegations:[{id:'work-1',project_id:'demo',session_id:'worker-1',instruction:'排查构建异常并验证修复结果',status:'running'},{id:'work-2',project_id:'demo',session_id:'worker-2',instruction:'整理本周已经完成的研发事项',status:'completed'}],
 runs:[{id:'run-1',status:'silent',summary:'构建排查仍在执行，暂无需要你确认的事项。',created_at:now,sources:{},deliveries:[]},{id:'run-2',status:'notified',summary:'本周研发事项已整理完成，结果已回到发起会话。',created_at:'2026-11-12T14:20:00Z',sources:{},deliveries:[]}]}
const calls={check:0,stop:0,voice:0,feedback:0,microphone:0,activity:0}
;(window as any).workspaceFixture={calls,getProfile:()=>profile,setPhase:(phase:string)=>useWakeState.setState({phase:phase as any}),setSpeaking:(value:boolean)=>window.dispatchEvent(new CustomEvent('workstep:digital-person-speaking',{detail:value}))}
useLocaleStore.setState({locale:'zh-CN'})
useProjectStore.setState({projects:[{id:'demo',name:'操作手册演示',path:'/demo',type:'local',is_default_workspace:true,workflows:[]}] as any,loading:false})
digitalPersonApi.get=async()=>({...profile,onboarding_completed:true})
digitalPersonApi.save=async value=>{profile={...value};return profile}
digitalRuntimeApi.activity=async()=>{calls.activity++;return activity}
speechApi.status=async()=>({enabled:false} as any)
voiceWakeApi.get=async()=>{calls.voice++;return {keyword:'你好小研',sensitivity:'balanced',available:false,listening:false}}
digitalRuntimeApi.feedback=async(id,value)=>{calls.feedback++;activity={...activity,feedback:{...activity.feedback,[id]:value}};return activity}
digitalRuntimeApi.check=async()=>{calls.check++;await new Promise(r=>setTimeout(r,250));activity={...activity,runs:[{id:'manual',status:'silent',summary:'当前任务仍在执行，无需通知。',created_at:now,sources:{},deliveries:[]},...activity.runs]};return {status:'silent'}}
digitalRuntimeApi.stop=async()=>{calls.stop++;return {stopped:true}}
const initial:AssistantChatMessage[]=[
 {id:'u1',role:'user',content:'帮我检查昨天的构建异常，处理完告诉我。',status:'completed',events:[],created_at:now},
 {id:'a1',role:'assistant',content:'已交给项目会话排查。我会跟进结果，有需要你确认的地方再提醒你。',status:'completed',engine:'codex',model:'gpt-6',events:[],created_at:now},
]
function Preview(){
 const [data,setData]=useState(activity),[input,setInput]=useState(''),[messages,setMessages]=useState(initial),[running,setRunning]=useState(false)
 useEffect(()=>{const refresh=()=>setData(activity);window.addEventListener('workstep:digital-person-activity-changed',refresh);return()=>window.removeEventListener('workstep:digital-person-activity-changed',refresh)},[])
 const send=()=>{
  if(!input.trim()||running)return
  const text=input;setInput('');setRunning(true)
  setMessages(rows=>[...rows,{id:'u-'+rows.length,role:'user',content:text,status:'completed',events:[],created_at:now}])
  window.setTimeout(()=>{setMessages(rows=>[...rows,{id:'a-'+rows.length,role:'assistant',content:'收到。我会先确认当前进展，再把需要处理的工作交给对应项目。',status:'completed',engine:'codex',model:'gpt-6',events:[],created_at:now}]);setRunning(false)},500)
 }
 const config={engines:[],engine:'codex',defaultEngine:'codex',model:'gpt-6',fastModel:'',onEngineChange:()=>{},onModelChange:()=>{},onFastModelChange:()=>{}}
 const copy={emptyIntro:profile.greeting,thinking:'思考中',me:'我',meInitials:'我',agent:profile.name,agentInitials:'研',placeholder:'说说你想做的事…',fullPrompt:'提示词',closePrompt:'关闭'}
 return <DigitalPersonWorkspace profile={profile} activity={data} running={running}><AssistantChatPanel projectId="demo" sessionId="main" title="与小研对话" messages={messages} running={running} stopping={false} input={input} copy={copy} locale="zh-CN" config={config} attachmentPrefix="fixture" onInputChange={setInput} onSend={send} onSendContent={async()=>true} onStop={()=>setRunning(false)} renderMessageActions={id=><DigitalPersonFeedback messageId={id} initialValue={data.feedback[id] || 0}/>}/></DigitalPersonWorkspace>
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><I18nProvider>{new URLSearchParams(location.search).get('view')==='card'?<div className="fixture-namecard"><DigitalPersonSettings onClose={()=>{}}/></div>:<Preview/>}</I18nProvider></BrowserRouter>)
