import {useEffect,useState} from 'react'
import type {DigitalActivity,DigitalAffectState,DigitalActivityRecords} from '../../api/digitalPerson'
import {digitalRuntimeApi} from '../../api/digitalPerson'
import type {AssistantChatMessage} from '../../stores/assistantStore'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import {DIGITAL_ACTIVITY_CHANGED} from './useDigitalActivity'
import DigitalPersonHomeDetails,{type HomeDetailKind} from './DigitalPersonHomeDetails'
import {captionContent} from './DigitalPersonCaptions'

/** One visible-page subscription supplies both the total and recent reflection records. */
export default function DigitalPersonHomeInsights({active,name,role,state,activity,affect,messages,chatShown,onConversation,onWork,onInspect}:{
 active:boolean;name:string;role?:string;state:string;activity:DigitalActivity|null;affect:DigitalAffectState|null;messages:AssistantChatMessage[];chatShown:boolean
 onConversation:(id?:string)=>void;onWork:()=>void;onInspect:()=>void
}){
 const {t}=useI18n(),[records,setRecords]=useState<DigitalActivityRecords|null>(null)
 useEffect(()=>{
  if(!active)return
  let alive=true,pending=false
  const load=async()=>{if(pending||document.hidden)return;pending=true;try{const data=await digitalRuntimeApi.records();if(alive)setRecords(data)}catch{if(alive)setRecords(null)}finally{pending=false}}
  void load();window.addEventListener(DIGITAL_ACTIVITY_CHANGED,load);document.addEventListener('visibilitychange',load)
  const timer=window.setInterval(load,30000)
  return()=>{alive=false;window.clearInterval(timer);window.removeEventListener(DIGITAL_ACTIVITY_CHANGED,load);document.removeEventListener('visibilitychange',load)}
 },[active])
 const [detail,setDetail]=useState<HomeDetailKind|null>(null),[selectedRun,setSelectedRun]=useState('')
 const inspect=(kind:HomeDetailKind,id='')=>{onInspect();setSelectedRun(id);setDetail(kind)}
 const recent=messages.filter(m=>['user','assistant'].includes(m.role)&&captionContent(m.content)).slice(-4)
 const work=activity?.delegations?.find(d=>['running','queued'].includes(d.status))||activity?.delegations?.at(-1)
 return <>
  <aside className="digital-home-presence-info" aria-label={t('digitalPerson.selfStats')}>
   <Button variant="ghost" className="digital-home-identity" onClick={()=>inspect('profile')}><strong><Icon name="bot" size={16}/><span title={name}>{name}</span></strong><span>{['thinking','checking'].includes(state)?<Spinner size={14}/>:<Icon name="audio-lines" size={14}/>} {t(state==='checking'?'digitalPerson.homeReflection':`digitalPerson.homeState${state}` as never)}<span>{activity?.level!=null?`Lv.${activity.level}`:'—'}</span></span></Button>
   <Button variant="ghost" className="digital-home-metric digital-home-affinity" onClick={()=>inspect('affinity')} aria-label={t('digitalPerson.affinity')}><strong><Icon name="message-circle-heart" size={16}/>{affect?.affinity??'—'}</strong><span>{t('digitalPerson.affinity')}</span></Button>
   <Button variant="ghost" className="digital-home-metric" onClick={()=>inspect('reflection')} aria-label={t('digitalPerson.homeReflection')}><strong><Icon name="lightbulb" size={16}/>{records?.run_total??'—'}</strong><span>{t('digitalPerson.homeReflection')}</span></Button>
  </aside>
  <aside className="digital-home-context" hidden={chatShown}>
   <section className="digital-home-reflections"><h2>{t('digitalPerson.thoughtHistory')}</h2>{records?.runs?.length?records.runs.slice(0,3).map(run=><Button key={run.id} variant="ghost" onClick={()=>inspect('reflection',run.id)}><Icon name={['running','notifying'].includes(run.status)?'loader-circle':'lightbulb'} className={['running','notifying'].includes(run.status)?'task-status-spinner':undefined} size={14}/><span>{run.summary||t(`digitalPerson.status${run.status.charAt(0).toUpperCase()+run.status.slice(1)}` as never)}</span><Icon name="chevron-right" size={14}/></Button>):<p>{records?t('digitalPerson.noThoughtRecords'):'—'}</p>}</section>
   {work&&<section className="digital-home-work"><Button variant="ghost" onClick={onWork}><Icon name="workflow" size={14}/><span>{work.instruction}</span><Icon name="chevron-right" size={14}/></Button></section>}
   <section className="digital-home-recent"><h2>{t('digitalPerson.homeRecentMessages')}</h2>{recent.map(message=><Button variant="ghost" key={message.id} data-recent-message={message.id} onClick={()=>onConversation(message.id)}><span>{message.role==='assistant'&&<small>{name}</small>}<span>{captionContent(message.content)}</span></span><Icon name="chevron-right" size={14}/></Button>)}</section>
  </aside>
  {active&&detail&&<DigitalPersonHomeDetails key={detail} kind={detail} name={name} role={role} state={state} activity={activity} affect={affect} records={records} initialRun={selectedRun} onClose={()=>setDetail(null)}/>}
 </>
}
