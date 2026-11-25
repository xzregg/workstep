/** Isolated UI fixture: actual production components, synthetic records and APIs. */
import React,{useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {BrowserRouter} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../../../src/i18n'
import AssistantChatPanel from '../../../src/components/AssistantChatPanel'
import DigitalPersonWorkspace from '../../../src/components/digital-person/DigitalPersonWorkspace'
import DigitalPersonFeedback from '../../../src/components/digital-person/DigitalPersonFeedback'
import SettingsPage from '../../../src/pages/SettingsPage'
import SettingsNavigation from '../../../src/components/SettingsNavigation'
import '../../../src/pages/SettingsPage.css'
import VoiceInputSettings from '../../../src/pages/VoiceInputSettings'
import DigitalPersonCamera from '../../../src/components/digital-person/DigitalPersonCamera'
import DigitalPersonSettings from '../../../src/components/digital-person/DigitalPersonSettings'
import SkinSettings from '../../../src/components/SkinSettings'
import ProviderSettings from '../../../src/pages/ProviderSettings'
import {skinsApi} from '../../../src/api/skins'
import {defaultSkin} from '../../../src/skins/contract'
import {digitalPersonApi,digitalRuntimeApi,voiceWakeApi,type DigitalActivity,type DigitalPersonProfile} from '../../../src/api/digitalPerson'
import {assistantApi,providerApi,systemSettingsApi,engineApi} from '../../../src/api/client'
import {speechApi} from '../../../src/api/speech'
import {speechOutputApi} from '../../../src/api/speechOutput'
import {outputStatus,qwenOutputModels} from '../speechOutput'
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
const sampleSkin={...defaultSkin(),manifest:{...defaultSkin().manifest,id:'settings-demo',name:'演示皮肤'},revision:'demo'}
skinsApi.list=async()=>[{manifest:sampleSkin.manifest,revision:sampleSkin.revision}]
skinsApi.get=async()=>sampleSkin
;(window as any).workspaceFixture={calls,getProfile:()=>profile,setLocale:(locale:string)=>useLocaleStore.setState({locale:locale as any}),setPhase:(phase:string)=>useWakeState.setState({phase:phase as any}),setSpeaking:(value:boolean)=>window.dispatchEvent(new CustomEvent('workstep:digital-person-speaking',{detail:value}))}
useLocaleStore.setState({locale:'zh-CN'})
useProjectStore.setState({projects:[{id:'demo',name:'操作手册演示',path:'/demo',type:'local',is_default_workspace:true,workflows:[]}] as any,loading:false})
digitalPersonApi.get=async()=>({...profile,onboarding_completed:true})
digitalPersonApi.save=async value=>{profile={...value};return profile}
digitalRuntimeApi.activity=async()=>{calls.activity++;return activity}
digitalRuntimeApi.records=async(runOffset=0,delegationOffset=0)=>{
 const demo=new URLSearchParams(location.search).get('activity')==='compact'
 const runs=demo?Array.from({length:28},(_,i)=>({id:`record-${i}`,status:i===1?'failed':i===2?'notified':'silent',summary:i===1?'检查失败，请核对引擎配置后重试':'项目构建仍在执行，暂时没有需要你确认的新事项。这里还有更长的检查结果用于验证列表截断。',created_at:new Date(Date.parse(now)-i*1800000).toISOString()})):activity.runs
 const delegations=demo?Array.from({length:12},(_,i)=>({id:`delegation-${i}`,project_id:'demo',session_id:'worker-1',instruction:i===0?'排查构建异常并验证修复结果，保留已有配置，完成后回到来源会话通知用户。':'整理本周研发事项及验证结果，汇总需要继续跟进的问题。',status:i<2?'running':'completed'})):activity.delegations
 return {checking:activity.checking,run_total:runs.length,delegation_total:delegations.length,delegation_pending:true,runs:runs.slice(runOffset,runOffset+5),delegations:delegations.slice(delegationOffset,delegationOffset+5).map((item,i)=>({...item,notification_state:['pending','read','notified','deferred','delivery_failed'][i%5],notification_run_id:'delivery-'+i}))}
}
digitalRuntimeApi.runDetail=async id=>({id,status:id==='record-1'?'failed':'silent',created_at:now,summary:'已核对当前执行状态：构建任务仍在运行，没有重复交办。下一轮将继续关注测试和健康检查结果。',...(id==='record-1'?{error:'无法连接已配置的引擎，请在大脑设置中检查连接。'}:{})})
digitalRuntimeApi.channels=async()=>new URLSearchParams(location.search).has('channels')?{
 available:[{id:'peer-new',bot_id:'demo-bot',bot_name:'研发机器人',platform:'dingtalk',conversation_type:'group',conversation_id:'new-group',title:'待绑定研发群'}],
 bindings:[{id:'peer-bound',bot_id:'demo-bot',bot_name:'研发机器人',platform:'dingtalk',conversation_type:'group',conversation_id:'bound-group',title:'已绑定研发群',notify:true}],
}:({available:[],bindings:[]})
let speechStatus={enabled:false,language:'auto',model_id:'demo',languages:['auto'],service:'stopped' as const,models:[{id:'demo',name:'Paraformer 三语版',license:'模型来源',license_url:'https://example.com',model_bytes:100,installed:true,punctuation:true,streaming:'native',install:{stage:'idle',downloaded_bytes:100,total_bytes:100,error:''}}],connection:{mode:'local',provider:'tencent',base_url:'',model:'16k_zh',resource_id:'volc.seedasr.sauc.duration',app_id:''} as import('../../../src/api/speech').SpeechConnection}
speechApi.status=async()=>structuredClone(speechStatus)
speechApi.configure=async(enabled,language,_id,connection)=>{speechStatus={...speechStatus,enabled,language,...(connection?{connection}:{})};return structuredClone({...speechStatus,ready:enabled,streaming:speechStatus.connection.provider==='openai'?'final':'native'}) as import('../../../src/api/speech').SpeechStatus}
;(window as any).workspaceFixture.getInputSettings=()=>speechStatus
let outputSettings=structuredClone(outputStatus.settings)
if(new URLSearchParams(location.search).get('voice')==='qwen')outputSettings={...outputSettings,mode:'local',model_id:'qwen-17-custom',voice:'Vivian'}
;(window as any).workspaceFixture.getOutputSettings=()=>outputSettings
speechOutputApi.status=async()=>structuredClone({...outputStatus,settings:outputSettings,models:[...outputStatus.models,...qwenOutputModels]})
speechOutputApi.save=async value=>{outputSettings={...value};return value}
assistantApi.list=async()=>({assistants:['digital_person','digital_person_reflection'].map(name=>({name,fields:['engine','provider_id','model','vision_model','thinking_effort'],configured:{},resolved:{engine:'pydantic_ai',provider_id:'demo'},available_engines:[{id:'pydantic_ai',installed:true,built_in:true,supports_coordinator:true,supports_provider:true,provider_protocols:['openai']}]}))}) as any
engineApi.list=async()=>({engines:[]}) as any
engineApi.refresh=async()=>({engines:[]}) as any
engineApi.models=async()=>({engine_id:'pydantic_ai',models:[{id:'demo-vl',label:'演示多模态模型',description:null}],default_model:'demo-vl',error:null})
systemSettingsApi.modelSettings=async()=>({currency:'CNY',usd_to_cny_rate:7,prices:[{provider_id:'demo',engine_id:null,model:'demo-vl',model_type:'chat',supports_multimodal:true,input_price:0,output_price:0,cache_price:0}],providers:[],engines:[],standalone_models:[]})
providerApi.list=async()=>({types:[],providers:[{id:'demo',name:'演示供应商',protocol:'openai',enabled:true,model_count:0}]}) as any
providerApi.models=async()=>({models:[],fetched_at:null}) as any
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
 const send=(content?:string)=>{
  if(!(content ?? input).trim()||running)return
  const text=content ?? input;(window as any).workspaceFixture.lastSent=text;setInput('');setRunning(true)
  setMessages(rows=>[...rows,{id:'u-'+rows.length,role:'user',content:text,status:'completed',events:[],created_at:now}])
  window.setTimeout(()=>{setMessages(rows=>[...rows,{id:'a-'+rows.length,role:'assistant',content:'收到。我会先确认当前进展，再把需要处理的工作交给对应项目。',status:'completed',engine:'codex',model:'gpt-6',events:[],created_at:now}]);setRunning(false)},500)
 }
 const config={engines:[],engine:'codex',defaultEngine:'codex',model:'gpt-6',fastModel:'',onEngineChange:()=>{},onModelChange:()=>{},onFastModelChange:()=>{}}
 const copy={emptyIntro:profile.greeting,thinking:'思考中',me:'我',meInitials:'我',agent:profile.name,agentInitials:'研',placeholder:'说说你想做的事…',fullPrompt:'提示词',closePrompt:'关闭'}
 return <DigitalPersonWorkspace profile={profile} activity={data} running={running}><AssistantChatPanel projectId="demo" sessionId="main" title="与小研对话" messages={messages} running={running} stopping={false} input={input} copy={copy} locale="zh-CN" config={config} attachmentPrefix="fixture" onInputChange={setInput} onSend={send} onSendContent={async()=>true} onStop={()=>setRunning(false)} renderMessageActions={id=><DigitalPersonFeedback messageId={id} initialValue={data.feedback[id] || 0}/>}/></DigitalPersonWorkspace>
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><I18nProvider>{new URLSearchParams(location.search).get('view')==='skin-settings'?<div className="fixture-namecard settings-content"><SkinSettings/></div>:new URLSearchParams(location.search).get('view')==='provider-settings'?<div className="fixture-namecard settings-content"><ProviderSettings/></div>:new URLSearchParams(location.search).get('view')==='camera'?<DigitalPersonCamera projectId="demo" autoStart onPrepare={prepare=>{(window as any).prepareCameraMessage=prepare}}/>:new URLSearchParams(location.search).get('view')==='settings'?<SettingsPage initialSection="digital-person" onClose={()=>{}}/>:new URLSearchParams(location.search).get('view')==='speech'?<div className="modal-overlay settings-dialog-overlay"><div className="modal settings-dialog-panel"><div className="modal-header settings-dialog-header"><span className="modal-title">设置</span><button type="button" aria-label="关闭设置">✕</button></div><div className="settings-layout"><SettingsNavigation activeSection="speech" onSelect={()=>{}}/><section className="settings-content"><VoiceInputSettings/></section></div></div></div>:new URLSearchParams(location.search).get('view')==='card'?<div className="fixture-namecard"><DigitalPersonSettings onClose={()=>{}}/></div>:<Preview/>}</I18nProvider></BrowserRouter>)
