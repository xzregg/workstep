import {useEffect,useId,useState} from 'react'
import {useNavigate} from 'react-router-dom'
import {digitalAffectApi,type DigitalAffectState} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import {useProjectStore} from '../../stores/projectStore'
import Button from '../Button'
import Select from '../Select'
import {useDigitalPersonAffect} from './useDigitalPersonAffect'
import './DigitalPersonRelationship.css'

export function RelationshipReadout({state,error='',onRetry}:{state:DigitalAffectState|null;error?:string;onRetry?:()=>void}){
 const {t}=useI18n(),navigate=useNavigate(),historyId=useId()
 const [historyShown,setHistoryShown]=useState(false)
 if(!state)return error?<div className="digital-affect digital-affect--error" role="status"><span>{t(error as never)}</span><Button variant="ghost" size="sm" onClick={onRetry}>{t('common.retry')}</Button></div>:null
 const level=state.affinity<30?'distant':state.affinity<60?'acquainted':state.affinity<80?'familiar':'close'
 const openSource=(projectId:string,sessionId:string)=>{
  const project=useProjectStore.getState().projects.find(p=>p.id===projectId)
  if(project)navigate(`/chat?project=${encodeURIComponent(project.name)}&session=${encodeURIComponent(sessionId)}`)
 }
 return <section className="digital-affect" data-affect-readonly>
  <div className="digital-affect-summary"><span>{t('digitalPerson.affinity')} <strong>{state.affinity}</strong>/100<span className="digital-affect-level">{t(`digitalPerson.relationship${level}` as never)}</span></span><span>{t(`digitalPerson.emotion${state.emotion}` as never)} · {Math.max(Math.abs(state.valence),state.arousal)}</span></div>
  {state.history[0]&&<div className="digital-affect-recent"><p><strong>{state.history[0].delta>0?'+':''}{state.history[0].delta}</strong> {state.history[0].reason}</p><Button variant="ghost" size="sm" aria-expanded={historyShown} aria-controls={historyId} onClick={()=>setHistoryShown(value=>!value)}>{t('digitalPerson.affectHistory')}</Button></div>}
  {historyShown&&<div className="digital-affect-detail" id={historyId}>
   {state.history.length===0?<p>{t('digitalPerson.affectNoHistory')}</p>:<ol>{state.history.map(event=><li key={event.id}>
    <div><strong>{event.delta>0?'+':''}{event.delta}</strong><span>{event.before_value} → {event.after_value}</span><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time></div>
    <p>{event.reason}</p>
    {useProjectStore.getState().projects.some(p=>p.id===event.project_id)&&<Button variant="ghost" onClick={()=>openSource(event.project_id,event.session_id)}>{t('digitalPerson.affectSource')}</Button>}
   </li>)}</ol>}
  </div>}
 </section>
}

/** Relationship inspection belongs in settings, never in the conversation stage. */
export default function DigitalPersonRelationship(){
 const {t}=useI18n(),[person,setPerson]=useState(''),[items,setItems]=useState<Array<{person_id:string;name:string}>>([])
 const {state,error,retry}=useDigitalPersonAffect(undefined,undefined,'',person)
 useEffect(()=>{let alive=true;void digitalAffectApi.people().then(data=>{if(alive){setItems(data.items);setPerson(current=>current||data.items[0]?.person_id||'')}}).catch(()=>{});return()=>{alive=false}},[])
 return <section className="digital-person-relationship">
  {items.length>0&&<label>{t('digitalPerson.relationshipPerson')}<Select value={person} onChange={e=>setPerson(e.target.value)}>{items.map(item=><option key={item.person_id} value={item.person_id}>{item.name||t('digitalPerson.currentPerson')}</option>)}</Select></label>}
  <RelationshipReadout state={state} error={error} onRetry={retry}/>
 </section>
}
