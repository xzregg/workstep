import {useEffect,useRef,useState} from 'react'
import type {DigitalActivity,DigitalAffectState,DigitalActivityRecords} from '../../api/digitalPerson'
import {digitalRuntimeApi} from '../../api/digitalPerson'
import type {AssistantChatMessage} from '../../stores/assistantStore'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import DigitalPersonRunOutcome from './DigitalPersonRunOutcome'
import {DIGITAL_ACTIVITY_CHANGED} from './useDigitalActivity'
import DigitalPersonHomeDetails,{type HomeDetailKind} from './DigitalPersonHomeDetails'

/** One visible-page subscription supplies both the total and recent reflection records. */
export default function DigitalPersonHomeInsights({active,name,role,state,activity,affect,chatShown,onInspect}:{
 active:boolean;name:string;role?:string;state:string;activity:DigitalActivity|null;affect:DigitalAffectState|null;messages:AssistantChatMessage[];chatShown:boolean
 onInspect:()=>void
}){
 const {t}=useI18n(),[records,setRecords]=useState<DigitalActivityRecords|null>(null)
 const [extra,setExtra]=useState<Pick<DigitalActivityRecords,'runs'|'delegations'>>({runs:[],delegations:[]})
 const [loading,setLoading]=useState(''),[pageError,setPageError]=useState('')
 const request=useRef({epoch:0,pending:false})
 const firstPage=useRef<DigitalActivityRecords|null>(null),exhausted=useRef(new Set<string>())
 const merge=<T extends {id:string}>(first:T[],rest:T[])=>[...first,...rest.filter(row=>!first.some(head=>head.id===row.id))]

 useEffect(()=>{
  if(!active)return
  let alive=true
  const epoch=++request.current.epoch;request.current.pending=false
  firstPage.current=null;exhausted.current.clear()
  setExtra({runs:[],delegations:[]});setLoading('');setPageError('')
  const load=async()=>{if(request.current.pending||document.hidden)return;request.current.pending=true;try{const data=await digitalRuntimeApi.records();if(alive){const previous=firstPage.current;firstPage.current=data;if(previous)setExtra(tail=>({runs:merge(previous.runs,tail.runs).filter(row=>!data.runs.some(head=>head.id===row.id)),delegations:merge(previous.delegations,tail.delegations).filter(row=>!data.delegations.some(head=>head.id===row.id))}));setRecords(data)}}catch{if(alive)setRecords(null)}finally{if(request.current.epoch===epoch)request.current.pending=false}}
  void load();window.addEventListener(DIGITAL_ACTIVITY_CHANGED,load);document.addEventListener('visibilitychange',load)
  const timer=window.setInterval(load,30000)
  return()=>{alive=false;request.current.epoch++;window.clearInterval(timer);window.removeEventListener(DIGITAL_ACTIVITY_CHANGED,load);document.removeEventListener('visibilitychange',load)}
 },[active])
 const [detail,setDetail]=useState<HomeDetailKind|null>(null),[selectedRun,setSelectedRun]=useState('')
 const inspect=(kind:HomeDetailKind,id='')=>{onInspect();setSelectedRun(id);setDetail(kind)}
 const runs=merge(records?.runs||[],extra.runs)
 const work=merge<DigitalActivityRecords['delegations'][number]>(records?.delegations??activity?.delegations?.slice(0,5)??[],extra.delegations)
 const loadMore=async(kind:'runs'|'delegations')=>{
  const rows=kind==='runs'?runs:work,total=kind==='runs'?records?.run_total:records?.delegation_total
  if(!active||chatShown||document.hidden||request.current.pending||exhausted.current.has(kind)||!records||rows.length>=(total??0))return
  const epoch=request.current.epoch;request.current.pending=true;setLoading(kind);setPageError('')
  try{const data=await digitalRuntimeApi.records(kind==='runs'?rows.length:0,kind==='delegations'?rows.length:0)
   if(request.current.epoch===epoch){if(data[kind].length<5||data[kind].every(row=>rows.some(saved=>saved.id===row.id)))exhausted.current.add(kind);setExtra(previous=>({...previous,[kind]:merge(previous[kind] as {id:string}[],data[kind])}))}
  }catch{if(request.current.epoch===epoch)setPageError(kind)}finally{if(request.current.epoch===epoch){request.current.pending=false;setLoading('')}}
 }
 const scroll=(kind:'runs'|'delegations',node:HTMLDivElement)=>{if(node.scrollHeight-node.scrollTop-node.clientHeight<64)void loadMore(kind)}
 const pageFooter=(kind:'runs'|'delegations')=><>{loading===kind&&<Spinner size={14}/ >}{pageError===kind&&<Button variant="ghost" onClick={()=>void loadMore(kind)}>{t('common.retry')}</Button>}</>
 const thoughtTitle=(value:string)=>['failed','error','stopped','interrupted','cancelled'].includes(value)?t('digitalPerson.homeThoughtIncomplete'):['silent','notified','completed','succeeded'].includes(value)?t('digitalPerson.homeThoughtComplete'):value==='running'?t('digitalPerson.homeStatethinking'):status(value)
 const time=(stamp?:string)=>stamp?<time dateTime={stamp} title={new Date(stamp).toLocaleString()}>{new Date(stamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false})}</time>:null
 const status=(value:string)=>{if(value==='failed')return t('digitalPerson.runIncompleteStatus');if(value==='running')return t('digitalPerson.homeStatethinking');const key=`digitalPerson.status${value.charAt(0).toUpperCase()+value.slice(1)}`,label=t(key as never);return label===key?t('digitalPerson.statusSilent'):label}
 return <>
  <aside className="digital-home-presence-info" aria-label={t('digitalPerson.selfStats')}>
   <Button variant="ghost" className="digital-home-identity" onClick={()=>inspect('profile')}><strong><Icon name="bot" size={16}/><span title={name}>{name}</span></strong><span>{['thinking','checking'].includes(state)?<Spinner size={14}/>:<Icon name="audio-lines" size={14}/>} {t(state==='checking'?'digitalPerson.homeReflection':`digitalPerson.homeState${state}` as never)}<span>{activity?.level!=null?`Lv.${activity.level}`:'—'}</span></span></Button>
   <Button variant="ghost" className="digital-home-metric digital-home-affinity" onClick={()=>inspect('affinity')} aria-label={t('digitalPerson.affinity')}><strong><Icon name="message-circle-heart" size={16}/>{affect?.affinity??'—'}</strong><span>{t('digitalPerson.affinity')}</span></Button>
   <Button variant="ghost" className="digital-home-metric" onClick={()=>inspect('reflection')} aria-label={t('digitalPerson.homeReflection')}><strong><Icon name="lightbulb" size={16}/>{records?.reflection_count??'—'}{records?.reflection_count_lower_bound?'+':''}</strong><span>{t('digitalPerson.homeReflection')}</span></Button>
  </aside>
  <aside className="digital-home-context" hidden={chatShown}>
   <header className="digital-home-activity-header"><h2>{t('digitalPerson.homeProactiveActivity')}</h2><small>{new Date().toLocaleDateString(undefined,{month:'long',day:'numeric'})}</small></header>
   <div className="digital-home-activity-regions">
    <section className="digital-home-reflections"><h3><Icon name="lightbulb" size={16}/>{t('digitalPerson.homeReflection')}</h3>
     <div className="digital-home-activity-scroll" data-activity-scroll="runs" role="region" aria-label={t('digitalPerson.thoughtHistory')} tabIndex={0} onScroll={event=>scroll('runs',event.currentTarget)}>
      {runs.map(run=><Button key={run.id} variant="ghost" className="digital-home-thought-event" data-status={run.status} onClick={()=>inspect('reflection',run.id)}><Icon name={['running','notifying'].includes(run.status)?'loader-circle':'lightbulb'} className={['running','notifying'].includes(run.status)?'task-status-spinner':undefined} size={14}/><span><span className="digital-home-event-heading"><strong>{thoughtTitle(run.status)}</strong>{time(run.created_at)}</span>{run.status!=='failed'&&run.summary&&run.summary!==thoughtTitle(run.status)&&<span className="digital-home-event-summary">{run.summary}</span>}<DigitalPersonRunOutcome outcome={run.outcome}/></span></Button>)}
      {!runs.length&&<p>{records?t('digitalPerson.noThoughtRecords'):'—'}</p>}{pageFooter('runs')}
     </div>
    </section>
    <section className="digital-home-work"><h3><Icon name="workflow" size={16}/>{t('digitalPerson.homeDelegatedTasks')}</h3>
     <div className="digital-home-activity-scroll" data-activity-scroll="delegations" role="region" aria-label={t('digitalPerson.homeDelegatedTasks')} tabIndex={0} onScroll={event=>scroll('delegations',event.currentTarget)}>
      {work.map(item=><div key={item.id} className="digital-home-work-summary"><span><span className="digital-home-event-heading"><strong className="digital-home-event-summary" title={item.instruction}>{item.instruction}</strong>{time(item.created_at)}</span><small className="digital-home-event-meta"><Icon name={['running','queued'].includes(item.status)?'loader-circle':['completed','succeeded'].includes(item.status)?'check':'workflow'} className={['running','queued'].includes(item.status)?'task-status-spinner':undefined} size={14}/>{item.status==='running'?t('digitalPerson.homeTaskRunning'):status(item.status)}{item.notification_state&&<span className="digital-home-work-notification">{item.notification_state==='read'?t('digitalPerson.homeNotificationRead'):item.notification_state==='pending'?t('digitalPerson.homeNotificationPending'):status(item.notification_state)}</span>}</small></span></div>)}
      {!work.length&&<p>{t('digitalPerson.homeNoWork')}</p>}{pageFooter('delegations')}
     </div>
    </section>
   </div>
  </aside>
  {active&&detail&&<DigitalPersonHomeDetails key={detail} kind={detail} name={name} role={role} state={state} activity={activity} affect={affect} records={records} initialRun={selectedRun} onClose={()=>setDetail(null)}/>}
 </>
}
