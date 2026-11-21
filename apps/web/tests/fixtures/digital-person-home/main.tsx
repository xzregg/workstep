/** Production components with isolated synthetic conversation, input and speech APIs. */
import {useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter,useLocation} from 'react-router-dom'
import ChatWorkspace from '../../../src/pages/ChatWorkspace'
import {useChatSessionStore} from '../../../src/stores/chatSessionStore'
import {I18nProvider,useLocaleStore} from '../../../src/i18n'
import DigitalPersonHome from '../../../src/components/digital-person/DigitalPersonHome'
import {speechOutputApi} from '../../../src/api/speechOutput'
import {speechApi} from '../../../src/api/speech'
import {pendingMessageInsertApi,type PendingMessageInsertItem} from '../../../src/api/conversations'
import {voiceCapture} from '../../../src/utils/voiceCapture'
import {TurnController} from '../../../src/audio/turnController'
import {useProjectStore} from '../../../src/stores/projectStore'
import {type AssistantChatMessage} from '../../../src/stores/assistantStore'
import {DIGITAL_OUTPUT_FRAME} from '../../../src/components/digital-person/digitalPersonVoiceEvents'
import SkinWorkspaceFrame from '../../../src/components/SkinExtensions'
import {defaultSkin} from '../../../src/skins/contract'
import {applySkin} from '../../../src/skins/runtime'
import {setSkinScriptsEnabled} from '../../../src/skins/scriptPreferences'
import * as avatarSkin from './avatarSkin'
import '../../../src/index.css'
import '../../../src/mobile.css'

useLocaleStore.setState({locale:'zh-CN'})
useProjectStore.setState({projects:[{id:'demo',name:'操作手册演示',path:'/demo',workflows:[]},{id:'p',name:'视频功能项目',path:'/video',workflows:[]}]})
let capture:Parameters<typeof voiceCapture.start>[0]|null=null,text='帮我看看今天的安排。',sequence=0
let ttsDelay=0,runStartDelay=0,sampleEnd=0,turn=new TurnController()
const log={captures:0,disposals:0,sent:[] as string[],inserted:[] as string[],stops:0,audio:0,playbackFrames:0}
const pending:PendingMessageInsertItem[]=[]
let insertSequence=0
pendingMessageInsertApi.list=async(_project,target)=>({items:pending.filter(item=>item.target_message_id===target)})
pendingMessageInsertApi.create=async(_project,target,content)=>{
 const item={id:`insert-${++insertSequence}`,target_message_id:target,content,position:pending.length,username:'',created_at:'',updated_at:''}
 pending.push(item)
 return item
}
pendingMessageInsertApi.remove=async(_project,id)=>{
 const index=pending.findIndex(item=>item.id===id)
 if(index>=0)pending.splice(index,1)
 return {deleted:index>=0}
}
window.addEventListener(DIGITAL_OUTPUT_FRAME,(event:Event)=>{const value=(event as CustomEvent).detail;if(value.playing&&value.level>0)log.playbackFrames++})
voiceCapture.start=async callback=>{capture=callback;sampleEnd=0;turn=new TurnController();log.captures++;return {stop:()=>{log.disposals++;capture=null},flush:async()=>turn.snapshot()}}
speechApi.status=async()=>({enabled:true,ready:true}) as any
speechApi.start=async()=>({id:`voice-${++sequence}`,sample_rate:16000,max_frame_samples:32000,streaming:'native'}) as any
speechApi.cancel=async()=>({cancelled:true}) as any
speechApi.audio=async(id,_project,sequence,_audio,final)=>({id,sequence,final,text})
speechOutputApi.status=async()=>({settings:{mode:'remote',model_id:'demo',voice:'demo',rate:1,volume:.1,remote_url:'https://example.invalid',remote_model:'demo'},models:[],voices:[],service:'ready'}) as any
speechOutputApi.start=async()=>{const id=`audio-${++log.audio}`;if(ttsDelay)await new Promise(resolve=>setTimeout(resolve,ttsDelay));return {id}}
speechOutputApi.cancel=async()=>({cancelled:true}) as any
speechOutputApi.next=async()=>{
 const bytes=new Uint8Array(16000);const view=new DataView(bytes.buffer)
 for(let i=0;i<8000;i++)view.setInt16(i*2,Math.sin(i/16000*Math.PI*440)*7000,true)
 return {done:true,audio:btoa(String.fromCharCode(...bytes)),format:'pcm',sample_rate:16000} as any
}
function feedAudio(count:number, level:number, probability:(index:number)=>number){
 for(let i=0;i<count;i++)turn.frame({end:sampleEnd+=512,probability:probability(i)})
 const pcm=Int16Array.from({length:count*512},(_,i)=>Math.sin(i*.1)*level*32768/3.5)
 capture?.(pcm,level,turn.snapshot())
}
;(window as any).homeFixture={
 log,setRunStartDelay:(ms:number)=>{runStartDelay=ms},setTtsDelay:(ms:number)=>{ttsDelay=ms},
 clickNoise:()=>feedAudio(16,.8,i=>i===0?.97:.02),
 sound:(level:number,nextText?:string)=>{if(nextText)text=nextText;feedAudio(16,level,()=>.8)},
 silence:()=>feedAudio(19,0,()=>.02),
 speaking:(playing:boolean,level=.6)=>window.dispatchEvent(new CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'demo',sessionId:'main',playing,level}}))
}
const initial:AssistantChatMessage[]=[{id:'user',role:'user',content:'帮我检查一下构建结果，并验证移动端的界面布局和按钮对齐。',status:'succeeded'},{id:'answer',role:'assistant',content:'已交给 WorkStep 项目新执行会话处理，后台处理中。重点检查移动端按钮、图标和文字的对齐，并验证不同屏幕下的显示。结果核验后会回到这里通知你。',status:'succeeded'}]
function App(){
 const [messages,setMessages]=useState(initial),[running,setRunning]=useState(false),[draft,setDraft]=useState('')
 const [uiReply,setUiReply]=useState<AssistantChatMessage>()
 const timers=useRef<ReturnType<typeof setTimeout>[]>([])
 const cancelTurn=()=>{timers.current.splice(0).forEach(timer=>clearTimeout(timer))}
 ;(window as any).homeFixture.setActivity=(kind:string,sequence=1)=>{
  if(kind==='idle'&&pending.length){log.inserted.push(...pending.splice(0).map(item=>item.content))}
  cancelTurn()
  setRunning(kind!=='idle')
  setMessages([...initial,{id:'motion-reply',role:'assistant',status:kind==='idle'?'succeeded':'running',content:kind==='reply'?'我正在整理回复。':'',events:kind==='think'?[{type:'REASONING_MESSAGE_CHUNK',delta:'核对当前上下文'}]:kind==='work'?[{type:'TOOL_CALL_START',toolCallId:`fixture-tool-${sequence}`,toolCallName:'read_file'}]:kind==='reply'?[{type:'TEXT_MESSAGE_CONTENT',content:'我正在整理回复。'}]:[]}])
 }

 Object.assign((window as any).homeFixture,{isRunning:()=>running,setHistory:setMessages,resetHistory:()=>setMessages(initial),
  uiAction:(id:string,action:object)=>setUiReply({id,role:'assistant',status:'succeeded',content:['```workstep-ui',JSON.stringify(action),'```'].join('\n')})})
 return <DigitalPersonHome profile={{enabled:true,name:'小研',role:'研发伙伴',personality:'温和',duties:'跟进工作',greeting:'我在，今天想先做什么？',avatar:'robot'}} activity={{level:3,experience:120,next_level_experience:200,checking:false,feedback:{},delegations:[{id:'work',project_id:'demo',session_id:'worker',instruction:'构建检查',status:'running'}]} as any}
  projectId="demo" projectName="操作手册演示" sessionId="main" active messages={messages} uiReply={uiReply} running={running}
  onSendPending={async value=>{log.inserted.push(value);return true}}
  onSend={async value=>{log.sent.push(value);cancelTurn();setDraft('');const begin=()=>{setRunning(true);setMessages(rows=>[...rows,{id:'user-'+rows.length,role:'user',content:value,status:'succeeded'},{id:'reply-'+rows.length,role:'assistant',content:'',status:'running'}]);timers.current.push(setTimeout(()=>{setMessages(rows=>rows.map((row,i)=>i===rows.length-1?{...row,content:'好，我来帮你整理今天的安排。',status:'running'}:row));timers.current.push(setTimeout(()=>{setRunning(false);setMessages(rows=>rows.map((row,i)=>i===rows.length-1?{...row,status:'succeeded'}:row))},500))},100))};if(runStartDelay)timers.current.push(setTimeout(begin,runStartDelay));else begin();return true}}
  inputValue={draft} onDraft={setDraft} onStop={async()=>{log.stops++;cancelTurn();setRunning(false);return true}}><div className="home-fixture-transcript">{messages.map(message=><p key={message.id} data-message-id={message.id} tabIndex={-1}>{message.content}</p>)}</div></DigitalPersonHome>
}
const customAvatar=new URLSearchParams(location.search).has('skinAvatar')
const workbench=new URLSearchParams(location.search).has('workbench')
if(workbench){
 const store=useProjectStore.getState()
 const home={...store.projects[0],is_default_workspace:true}
 useProjectStore.setState({projects:[home,...store.projects.slice(1)],activeProject:home})
 ;(window as any).finishWorkbenchTurn=(id:string,action:object)=>useChatSessionStore.getState().handleWsEvent({
  type:'TEXT_MESSAGE_END',channel:'session_chat',session_id:'main',messageId:id,status:'succeeded',
  content:['```workstep-ui',JSON.stringify(action),'```'].join('\n'),
 })
}
if(customAvatar){
 const defaults=defaultSkin(),skin={...defaults,manifest:{...defaults.manifest,id:'avatar-fixture',schema_version:2},revision:'avatar-fixture',script:'theme.js',file_base:'/fixture'}
 applySkin(skin);setSkinScriptsEnabled(skin,true)
}
const loadAvatar=async()=>avatarSkin
function WorkbenchFixture(){
 const {pathname,search}=useLocation()
 return <div className="app-shell" data-workbench-route={pathname+search}><ChatWorkspace/></div>
}
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={workbench?['/chat?project='+encodeURIComponent('操作手册演示')+'&session=main']:undefined}><I18nProvider>{workbench?<WorkbenchFixture/>:customAvatar?<SkinWorkspaceFrame onOpenSettings={()=>{}} loadModule={loadAvatar}><div className="app-shell"><App/></div></SkinWorkspaceFrame>:<div className="app-shell app-shell--companion"><App/></div>}</I18nProvider></MemoryRouter>)
const css=document.createElement('style');css.textContent='html,body,#root{height:100%;margin:0;overflow:hidden}.home-fixture-transcript{padding:16px;overflow:auto;flex:1}';document.head.appendChild(css)
