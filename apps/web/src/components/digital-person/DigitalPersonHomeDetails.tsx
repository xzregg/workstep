import { localizeErrorDisplay } from '../../i18n'
import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import type {DigitalActivity,DigitalActivityRecords,DigitalAffectState} from '../../api/digitalPerson'
import {digitalRuntimeApi} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import {useOverlay} from '../../hooks/useOverlay'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import ResizablePanel from '../ResizablePanel'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import {RelationshipReadout} from './DigitalPersonRelationship'
import DigitalPersonRunDetail from './DigitalPersonRunDetail'
import {DigitalPersonRunHeader} from './DigitalPersonRunKnowledge'
import DigitalPersonRunOutcome, {DigitalPersonRunNotificationStatus,DigitalPersonRunNotificationReasons} from './DigitalPersonRunOutcome'
import WakePreferenceSwitch from './WakePreferenceSwitch'
import './DigitalPersonHomeDetails.css'

export type HomeDetailKind='profile'|'affinity'|'reflection'
export default function DigitalPersonHomeDetails({kind,canControlWake,name,role,state,activity,affect,records,onClose}:{
 kind:HomeDetailKind;name:string;role?:string;state:string;activity:DigitalActivity|null;affect:DigitalAffectState|null;records:DigitalActivityRecords|null;onClose:()=>void
 canControlWake?:boolean
}){
 const {t,locale}=useI18n(),panel=useRef<HTMLDivElement>(null),compact=useCompactLayout()
 const [page,setPage]=useState(0),[data,setData]=useState<DigitalActivityRecords|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0),[openRun,setOpenRun]=useState('')
 useOverlay(true,onClose,panel,compact)
 useEffect(()=>{
  if(kind!=='reflection')return
  const bridge=window.WorkStepAndroid
  // Old APKs ignore this message; native views cannot be covered by CSS z-index.
  const notify=(open:boolean)=>{try{bridge?.postMessage(JSON.stringify({type:'thought-history',open}))}catch{/* The host may be navigating away. */}}
  notify(true)
  return()=>notify(false)
 },[kind])
 useEffect(()=>{
  if(kind!=='reflection'||page===0)return
  let alive=true;setLoading(true);setError('');setData(null)
  void digitalRuntimeApi.records(page*5).then(value=>{if(alive)setData(value)},reason=>{if(alive)setError(String(reason))}).finally(()=>{if(alive)setLoading(false)})
  return()=>{alive=false}
 },[kind,page,revision])
 const current=page===0?records:data,total=current?.run_total??records?.run_total??0,pages=Math.max(1,Math.ceil(total/5))
 const title=t(kind==='profile'?'digitalPerson.title':kind==='affinity'?'digitalPerson.affinity':'digitalPerson.thoughtHistory')
 return createPortal(<div className={`digital-home-detail-backdrop${kind==='reflection'?' digital-home-detail-backdrop--reflection':''}`} onClick={onClose}>
  <ResizablePanel ref={panel} className={`digital-home-detail-panel${kind==='reflection'?' digital-home-detail-panel--reflection':''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={event=>event.stopPropagation()}>
   <header><h2>{kind==='reflection'&&<Icon name="lightbulb"/>}{title}</h2><Button variant="icon" className="digital-home-detail-close" aria-label={t('common.close')} onClick={onClose}><Icon name="x"/></Button></header>
   <div className="digital-home-detail-content">
    {kind==='profile'&&<><div className="digital-home-detail-profile"><Icon name="bot" size={24}/><div><h3>{name}</h3>{role&&<p>{role}</p>}</div><strong>{activity?.level!=null?`Lv.${activity.level}`:'—'}</strong></div><p className="digital-home-detail-state">{t(state==='checking'?'digitalPerson.homeReflection':`digitalPerson.homeState${state}` as never)}</p>{activity&&<><progress value={activity.experience??0} max={activity.next_level_experience||1}/><p>{t('digitalPerson.experience',{count:activity.experience??0,next:activity.next_level_experience??0})}</p><dl className="digital-home-detail-stats">{[['sessionCount',activity.session_count],['replyCount',activity.reply_count],['taskCount',activity.task_count],['completedTaskCount',activity.completed_task_count]].map(([label,value])=><div key={label}><dt>{t(`digitalPerson.${label}` as never)}</dt><dd>{value??'—'}</dd></div>)}</dl></>}</>}
    {kind==='profile'&&canControlWake&&<WakePreferenceSwitch className="digital-home-detail-switch-row" label={t('voiceWake.title')}/>}
    {kind==='affinity'&&(affect?<RelationshipReadout state={affect}/>:<p>{t('digitalPerson.affectUnavailable')}</p>)}
    {kind==='reflection'&&(loading?<div className="digital-home-detail-loading"><Spinner/></div>:error?<div role="alert"><p>{localizeErrorDisplay(error)}</p><Button onClick={()=>setRevision(value=>value+1)}>{t('common.retry')}</Button></div>:current?.runs?.length?current.runs.map(run=>{
     const busy=['running','notifying'].includes(run.status),statusKey=run.status==='delivery_failed'?'digitalPerson.runNotificationFailed':`digitalPerson.status${run.status.charAt(0).toUpperCase()+run.status.slice(1)}`,status=t(statusKey as never),label=run.status==='failed'?t('digitalPerson.runIncompleteStatus'):run.status==='running'?t('digitalPerson.homeStatethinking'):status===statusKey?t('digitalPerson.homeReflection'):status
     const expanded=openRun===run.id
     const fallback=run.status==='failed'?t('digitalPerson.homeThoughtIncomplete'):run.summary||label
     const showStatus=run.processing || (run.status!=='failed' && fallback!==label)
     return <div className="digital-home-detail-run" key={run.id} data-expanded={expanded}>
      <DigitalPersonRunHeader runId={run.id} className="digital-home-detail-run-header" processing={run.processing} fallback={fallback}
       expanded={expanded} onToggle={()=>setOpenRun(expanded?'':run.id)}
       leadingIcon={<Icon name={busy?'loader-circle':'lightbulb'} className={busy?'digital-home-detail-run-icon task-status-spinner':'digital-home-detail-run-icon'}/>}>
         {showStatus&&<span>{run.status==='silent'?<DigitalPersonRunNotificationStatus run={run}/>:label}</span>}
         <DigitalPersonRunOutcome outcome={run.outcome}/>
         <time dateTime={run.created_at} title={new Date(run.created_at).toLocaleString(locale)}>{new Date(run.created_at).toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}</time>
      </DigitalPersonRunHeader>
      {!expanded&&!busy&&<DigitalPersonRunNotificationReasons run={run}/>}
      {expanded&&<DigitalPersonRunDetail id={run.id} busy={false} processingInList={run.processing} affinityInList={!!run.outcome}
       summaryInList={run.processing ? undefined : run.summary}/>}
     </div>
    }):<p>{current?t('digitalPerson.noThoughtRecords'):'—'}</p>)}
   </div>
   {kind==='reflection'&&<footer><nav className="digital-home-detail-pages" aria-label={title}><span>{page+1} / {pages}</span><Button variant="icon" aria-label={t('digitalPerson.previousPage')} disabled={loading||page===0} onClick={()=>{setOpenRun('');setPage(value=>value-1)}}><Icon name="chevron-left"/></Button><Button variant="icon" aria-label={t('digitalPerson.nextPage')} disabled={loading||page+1>=pages} onClick={()=>{setOpenRun('');setPage(value=>value+1)}}><Icon name="chevron-right"/></Button></nav></footer>}
  </ResizablePanel>
 </div>,document.body)
}
