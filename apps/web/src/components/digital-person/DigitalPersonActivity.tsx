import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { digitalRuntimeApi, type DigitalActivity } from '../../api/digitalPerson'
import { useProjectStore } from '../../stores/projectStore'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import DigitalPersonFeedback from './DigitalPersonFeedback'
import { DIGITAL_ACTIVITY_CHANGED } from './useDigitalActivity'
import Select from '../Select'
import Spinner from '../Spinner'
import './DigitalPersonActivity.css'

export default function DigitalPersonActivity({onNavigate}: {onNavigate?:()=>void}) {
  const { t } = useI18n(), navigate = useNavigate()
  const projects = useProjectStore(s => s.projects)
  const [data,setData] = useState<DigitalActivity | null>(null)
  const [error,setError] = useState(''), [busy,setBusy] = useState(false)
  const [project,setProject] = useState(''), [instruction,setInstruction] = useState('')
  const delegationRequest = useRef({signature:'',id:''})
  const [revision,setRevision] = useState(0)
  useEffect(() => {
    let active = true, pending = false
    const load = async () => {
      if(pending) return
      pending = true
      try { const result = await digitalRuntimeApi.activity(); if(active) {setData(result);setError('')} }
      catch(e) { if(active) setError(String(e)) }
      finally { pending = false }
    }
    window.addEventListener(DIGITAL_ACTIVITY_CHANGED,load)
    void load(); const timer = window.setInterval(load,15000)
    return () => { active = false; window.removeEventListener(DIGITAL_ACTIVITY_CHANGED,load); window.clearInterval(timer) }
  },[revision])
  const action = async (fn: () => Promise<unknown>) => {
    if(busy) return
    setBusy(true); setError('')
    try { await fn(); setRevision(v=>v+1) } catch(e) {setError(String(e))} finally {setBusy(false)}
  }
  const status=(value:string)=>t(`digitalPerson.status${value.charAt(0).toUpperCase()+value.slice(1)}` as never)
  return <div className="digital-person-activity">
    {error && <p role="alert">{error}</p>}
    {!data && !error && <Spinner />}
    <div className="digital-person-actions digital-person-activity-toolbar">
      <Button variant="primary" loading={busy || data?.checking} disabled={busy || data?.checking} onClick={()=>void action(()=>digitalRuntimeApi.check())}>{t('digitalPerson.checkNow')}</Button>
      {(busy || data?.checking) && <Button variant="ghost" disabled={!busy && !data?.checking} onClick={()=>void digitalRuntimeApi.stop().catch(e=>setError(String(e)))}>{t('common.stop')}</Button>}
      <Button variant="ghost" className="digital-person-refresh" disabled={busy} aria-label={t('settings.refresh')} title={t('settings.refresh')} onClick={()=>setRevision(v=>v+1)}><Icon name="refresh" size={16}/></Button>
    </div>
    {data && <>
      <div className="digital-person-growth"><strong>Lv.{data.level}</strong><progress value={data.experience} max={data.next_level_experience}/><span>{t('digitalPerson.experience', {count:data.experience,next:data.next_level_experience})}</span></div>
      
      <details><summary>{t('digitalPerson.assignWork')}</summary><div className="digital-person-form">
        <Select value={project} onChange={e=>setProject(e.target.value)} aria-label={t('digitalPerson.targetProject')}><option value="">{t('digitalPerson.targetProject')}</option>{projects.filter(p=>p.type!=='remote' && !p.is_default_workspace).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <textarea value={instruction} onChange={e=>setInstruction(e.target.value)} maxLength={12000} aria-label={t('digitalPerson.workInstruction')}/>
        <Button disabled={busy || !project || !instruction.trim()} onClick={()=>void action(async()=>{const signature=JSON.stringify([project,instruction]);if(delegationRequest.current.signature!==signature)delegationRequest.current={signature,id:crypto.randomUUID()};await digitalRuntimeApi.delegate(project,instruction,delegationRequest.current.id);setInstruction('');delegationRequest.current={signature:'',id:''}})}>{t('digitalPerson.assignWork')}</Button>
      </div></details>
      <h3>{t('digitalPerson.delegations')}</h3>
      {data.delegations.map(item=><div className="digital-person-run" key={item.id}><strong>{item.instruction}</strong><span className="digital-person-run-status">{status(item.status)}</span><Button onClick={()=>{const p=projects.find(p=>p.id===item.project_id);if(p){useProjectStore.getState().setActiveProject(p);navigate(`/chat?project=${encodeURIComponent(p.name)}&session=${item.session_id}`);onNavigate?.()}}}>{t('digitalPerson.viewExecution')}</Button>{['running','queued'].includes(item.status) && <Button disabled={busy} onClick={()=>void action(()=>digitalRuntimeApi.stopDelegation(item.id))}>{t('common.stop')}</Button>}</div>)}
      <h3>{t('digitalPerson.activity')}</h3>
      {!data.runs.length && <p>{t('digitalPerson.noRuns')}</p>}
      {data.runs.map(run=><details className="digital-person-run" key={run.id}><summary>{new Date(run.created_at).toLocaleString()} — {status(run.status)}</summary><p>{run.summary || run.error}</p>{run.status==='delivery_failed' && <Button disabled={busy} onClick={()=>void action(()=>digitalRuntimeApi.retryDelivery(run.id))}>{t('common.retry')}</Button>}<details className="digital-person-run-evidence"><summary>{t('digitalPerson.responseDetails')}</summary><pre>{JSON.stringify({sources:run.sources,deliveries:run.deliveries},null,2)}</pre></details></details>)}
      <h3>{t('digitalPerson.feedback')}</h3>
      {data.answers.map(answer=><div className="digital-person-run digital-person-answer" key={answer.id}><p>{answer.content}</p><DigitalPersonFeedback messageId={answer.id} initialValue={answer.feedback}/></div>)}
    </>}
  </div>
}
