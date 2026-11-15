/** Production components with isolated synthetic conversation, input and speech APIs. */
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../../../src/i18n'
import DigitalPersonHome from '../../../src/components/digital-person/DigitalPersonHome'
import {speechOutputApi} from '../../../src/api/speechOutput'
import {speechApi} from '../../../src/api/speech'
import {voiceCapture} from '../../../src/utils/voiceCapture'
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
useProjectStore.setState({projects:[{id:'demo',name:'操作手册演示',path:'/demo',workflows:[]}]})
let capture:((samples:Int16Array,level:number)=>void)|null=null,text='帮我看看今天的安排。',sequence=0
let ttsDelay=0
const log={captures:0,disposals:0,sent:[] as string[],stops:0,audio:0,playbackFrames:0}
window.addEventListener(DIGITAL_OUTPUT_FRAME,(event:Event)=>{const value=(event as CustomEvent).detail;if(value.playing&&value.level>0)log.playbackFrames++})
voiceCapture.start=async callback=>{capture=callback;log.captures++;return {stop:()=>{log.disposals++;capture=null},flush:async()=>{}}}
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
;(window as any).homeFixture={log,setTtsDelay:(ms:number)=>{ttsDelay=ms},clickNoise:()=>{const pcm=new Int16Array(8000);pcm.fill(6000,0,320);capture?.(pcm,.8)},sound:(level:number,nextText?:string)=>{if(nextText)text=nextText;capture?.(Int16Array.from({length:8000},(_,i)=>Math.sin(i*.1)*level*32768/3.5),level)},speaking:(playing:boolean,level=.6)=>window.dispatchEvent(new CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:'demo',sessionId:'main',playing,level}}))}
const initial:AssistantChatMessage[]=[{id:'user',role:'user',content:'帮我检查一下构建结果，并验证移动端的界面布局和按钮对齐。',status:'succeeded'},{id:'answer',role:'assistant',content:'已交给 WorkStep 项目新执行会话处理，后台处理中。重点检查移动端按钮、图标和文字的对齐，并验证不同屏幕下的显示。结果核验后会回到这里通知你。',status:'succeeded'}]
function App(){
 const [messages,setMessages]=useState(initial),[running,setRunning]=useState(false),[draft,setDraft]=useState('')
 ;(window as any).homeFixture.setActivity=(kind:string,sequence=1)=>{
  setRunning(kind!=='idle')
  setMessages([...initial,{id:'motion-reply',role:'assistant',status:kind==='idle'?'succeeded':'running',content:kind==='reply'?'我正在整理回复。':'',events:kind==='think'?[{type:'REASONING_MESSAGE_CHUNK',delta:'核对当前上下文'}]:kind==='work'?[{type:'TOOL_CALL_START',toolCallId:`fixture-tool-${sequence}`,toolCallName:'read_file'}]:kind==='reply'?[{type:'TEXT_MESSAGE_CONTENT',content:'我正在整理回复。'}]:[]}])
 }

 Object.assign((window as any).homeFixture,{isRunning:()=>running,setHistory:setMessages,resetHistory:()=>setMessages(initial)})
 return <DigitalPersonHome profile={{enabled:true,name:'小研',role:'研发伙伴',personality:'温和',duties:'跟进工作',greeting:'我在，今天想先做什么？',avatar:'robot'}} activity={{delegations:[{id:'work',project_id:'demo',session_id:'worker',instruction:'构建检查',status:'running'}]} as any}
  projectId="demo" projectName="操作手册演示" sessionId="main" active messages={messages} running={running}
  onSend={async value=>{log.sent.push(value);setDraft('');setRunning(true);setMessages(rows=>[...rows,{id:'user-'+rows.length,role:'user',content:value,status:'succeeded'},{id:'reply-'+rows.length,role:'assistant',content:'',status:'running'}]);setTimeout(()=>{setMessages(rows=>rows.map((row,i)=>i===rows.length-1?{...row,content:'好，我来帮你整理今天的安排。',status:'running'}:row));setTimeout(()=>{setRunning(false);setMessages(rows=>rows.map((row,i)=>i===rows.length-1?{...row,status:'succeeded'}:row))},500)},100);return true}}
  inputValue={draft} onDraft={setDraft} onStop={async()=>{log.stops++;setRunning(false);return true}}><div className="home-fixture-transcript">{messages.map(message=><p key={message.id}>{message.content}</p>)}</div></DigitalPersonHome>
}
const customAvatar=new URLSearchParams(location.search).has('skinAvatar')
if(customAvatar){
 const defaults=defaultSkin(),skin={...defaults,manifest:{...defaults.manifest,id:'avatar-fixture',schema_version:2},revision:'avatar-fixture',script:'theme.js',file_base:'/fixture'}
 applySkin(skin);setSkinScriptsEnabled(skin,true)
}
const loadAvatar=async()=>avatarSkin
createRoot(document.getElementById('root')!).render(<MemoryRouter><I18nProvider>{customAvatar?<SkinWorkspaceFrame onOpenSettings={()=>{}} loadModule={loadAvatar}><div className="app-shell"><App/></div></SkinWorkspaceFrame>:<App/>}</I18nProvider></MemoryRouter>)
const css=document.createElement('style');css.textContent='html,body,#root{height:100%;margin:0;overflow:hidden}.home-fixture-transcript{padding:16px;overflow:auto;flex:1}';document.head.appendChild(css)
