import { useEffect, useRef, useState } from 'react'
import AssistantChatPanel from '../AssistantChatPanel'
import { assistantApi, providerApi, type AssistantConfigInfo, type ProviderInfo } from '../../api/client'
import { useCoordinatorEngines } from '../../stores/engineAvailabilityStore'
import { usePrototypeStore } from '../../stores/prototypeStore'
import { prototypeApi, type PrototypeSelection } from '../../api/prototype'
import { useI18n } from '../../i18n'
import { flushWsSubscriptionNow } from '../../hooks/useWebSocket'
import { randomUuid } from '../../utils/uuid'

const drafts = new Map<string, string>()

export default function PrototypeChat({projectId,workspaceId,path,selection,comment,onCommentSent,onCommentFailed,disabled}: {
  projectId:string;workspaceId:string;path:string;selection:PrototypeSelection|null;
  comment:{text:string;key:string}|null;onCommentSent:()=>void;onCommentFailed:()=>void;disabled:boolean
}) {
  const {t,locale}=useI18n()
  const draftKey = `${projectId}:${workspaceId}:${path}`
  const submitting = useRef(false)
  const [sending,setSending] = useState(false)
  const [sid,setSid]=useState(''),[input,setInput]=useState(()=>drafts.get(draftKey)||''),[error,setError]=useState(''),[stopping,setStopping]=useState(false)
  const [settings,setSettings]=useState<AssistantConfigInfo|null>(null),[providers,setProviders]=useState<ProviderInfo[]>([])
  const [engine,setEngine]=useState(''),[model,setModel]=useState(''),[provider,setProvider]=useState(''),[effort,setEffort]=useState('')
  const engines=useCoordinatorEngines()
  const session=usePrototypeStore(s=>s.sessions[sid])
  const api=prototypeApi(projectId,workspaceId)
  useEffect(()=>{let active=true;Promise.all([assistantApi.list(),providerApi.list()]).then(([list,p])=>{
    if(active){setSettings(list.assistants.find(a=>a.name==='prototype')||null);setProviders(p.providers.filter(item=>item.enabled))}
  }).catch(e=>active&&setError(String(e)));return()=>{active=false}},[projectId])
  useEffect(()=>{let active=true;setSid('');api.history(path).then(history=>{
    if(!active)return;setEngine(history.engine||'');setModel(history.model||'');usePrototypeStore.getState().hydrateSession(history.session_id,history.messages);setSid(history.session_id);flushWsSubscriptionNow()
  }).catch(e=>active&&setError(String(e)));return()=>{active=false}},[projectId,workspaceId,path])
  const send=async(content:string,key=randomUuid())=>{
    if(!sid||!content.trim()||session?.running||disabled||submitting.current)return false
    submitting.current=true;setSending(true)
    setError('')
    const store=usePrototypeStore.getState(),message=store.addUserMessage(sid,content)
    try{flushWsSubscriptionNow();const accepted=await api.chat({path,content,selection,engine:engine||null,model:model||null,provider_id:provider||null,thinking_effort:effort||null},key)
      store.confirmUserMessage(sid,message,accepted.turn_id)
      store.acceptAssistantReply(sid,accepted.assistant_message_id,{status:accepted.status});return true
    }catch(e){store.removeMessage(sid,message);setError(String(e));return false}finally{submitting.current=false;setSending(false)}
  }
  useEffect(()=>{if(comment&&sid&&!disabled)void send(comment.text,comment.key).then(ok=>{if(ok)onCommentSent();else onCommentFailed()})},[comment?.key,sid,disabled])
  return <AssistantChatPanel visibilityPermission="file.edit" projectId={projectId} sessionId={sid} title={t('prototype.assistant')}
    messages={session?.messages||[]} running={Boolean(session?.running)} stopping={stopping}
    composerDisabled={!sid||disabled||sending}
    input={input} onInputChange={value=>{drafts.set(draftKey,value);setInput(value)}} sendError={error} locale={locale} attachmentPrefix={path}
    onSend={()=>void send(input).then(ok=>{if(ok){drafts.delete(draftKey);setInput('')}})} onSendContent={content=>send(content)}
    onStop={()=>{setStopping(true);void api.stop(path).catch(e=>setError(String(e))).finally(()=>setStopping(false))}}
    composerStatus={selection?<span className="prototype-context">{t('prototype.selected')} {selection.tag} {selection.text.slice(0,32)}</span>:undefined}
    copy={{emptyIntro:t('prototype.intro'),thinking:t('aiFlow.thinking'),me:t('aiFlow.me'),meInitials:t('aiFlow.meInitials'),agent:t('prototype.assistant'),agentInitials:'AI',placeholder:t('prototype.placeholder'),fullPrompt:t('aiFlow.fullPrompt'),closePrompt:t('aiFlow.closePrompt')}}
    config={{projectId,engines,engine,model,fastModel:'',defaultEngine:settings?.resolved?.engine||'',providers,providerId:provider,thinkingEffort:effort,
      disabled:!settings||Boolean(session?.running)||disabled,onEngineChange:value=>{setEngine(value);setModel('');setProvider('')},onModelChange:setModel,onProviderChange:setProvider,onFastModelChange:()=>{},onThinkingEffortChange:setEffort}}
  />
}
