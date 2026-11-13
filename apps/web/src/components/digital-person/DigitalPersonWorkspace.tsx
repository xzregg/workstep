import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { digitalRuntimeApi, voiceWakeApi, type DigitalActivity, type DigitalPersonProfile } from '../../api/digitalPerson'
import { useProjectStore } from '../../stores/projectStore'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import MobileSheet from '../MobileSheet'
import { useWakeState } from './digitalPersonWakeState'
import { DIGITAL_ACTIVITY_CHANGED } from './useDigitalActivity'
import './DigitalPersonWorkspace.css'

type Props = { profile: DigitalPersonProfile | null; activity: DigitalActivity | null; running: boolean; children: ReactNode }

/** A presentation layer over the existing chat and runtime, with no second session or poller. */
export default function DigitalPersonWorkspace({profile,activity,running,children}: Props) {
  const {t,locale}=useI18n(),navigate=useNavigate()
  const projects=useProjectStore(s=>s.projects)
  const listening=useWakeState(s=>s.listening)
  const voicePhase=useWakeState(s=>s.phase)
  const wakeError=useWakeState(s=>s.error)
  const [speaking,setSpeaking]=useState(false),[details,setDetails]=useState(false)
  const [checking,setChecking]=useState(false),[startingVoice,setStartingVoice]=useState(false)
  const [error,setError]=useState(''),[notice,setNotice]=useState('')
  useEffect(()=>{
    const changed=(event:Event)=>setSpeaking(Boolean((event as CustomEvent<boolean>).detail))
    window.addEventListener('workstep:digital-person-speaking',changed)
    return()=>window.removeEventListener('workstep:digital-person-speaking',changed)
  },[])
  if(!profile?.enabled)return <>{children}</>
  const pending=activity?.delegations.filter(d=>['running','queued'].includes(d.status)) || []
  const state=speaking?'speaking':listening?(voicePhase==='recording'?'listening':'starting'):running?'thinking':checking || activity?.checking?'checking':!activity?'unknown':pending.length?'following':'idle'
  const latest=activity?.runs[0]
  const time=(value?:string)=>{
    const date=value?new Date(value):null
    return date && Number.isFinite(date.getTime())?date.toLocaleTimeString(locale,{hour:'2-digit',minute:'2-digit'}):'—'
  }
  const check=async()=>{
    if(checking || activity?.checking)return
    setChecking(true);setError('');setNotice('')
    try{
      const result=await digitalRuntimeApi.check() as {status?:string;error?:string}
      if(result.status==='failed')throw new Error(result.error || t('digitalPerson.checkFailed'))
      setNotice(['delivery_failed','deferred','cancelled','interrupted','notifying'].includes(result.status || '') ? status(result.status!) : t(result.status==='notified'?'digitalPerson.checkNotified':'digitalPerson.checkQuiet'))
      window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED))
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason))}
    finally{setChecking(false)}
  }
  const listen=async()=>{
    if(listening){useWakeState.setState({listening:false});return}
    if(startingVoice)return
    setStartingVoice(true);setError('');useWakeState.setState({error:''})
    try{
      const config=await voiceWakeApi.get()
      useWakeState.setState({keyword:config.keyword,sensitivity:config.sensitivity,listening:true,error:''})
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason))}
    finally{setStartingVoice(false)}
  }
  const openWork=(item:DigitalActivity['delegations'][number])=>{
    const project=projects.find(p=>p.id===item.project_id)
    if(!project){setError(t('digitalPerson.projectUnavailable'));return}
    useProjectStore.getState().setActiveProject(project)
    navigate(`/chat?project=${encodeURIComponent(project.name)}&session=${encodeURIComponent(item.session_id)}`)
    setDetails(false)
  }
  const status=(value:string)=>t(`digitalPerson.status${value.charAt(0).toUpperCase()+value.slice(1)}` as never)
  const core=<img className="digital-console-core" src={new URL('../../assets/digital-person-cognition.png', import.meta.url).href} alt="" draggable={false}/>
  const inspector=<div className="digital-console-inspector">
    <section className="digital-console-section">
      <div className="digital-console-section-heading"><Icon name="radio" size={15}/><h3>{t('digitalPerson.proactive')}</h3><span>{activity?.checking || checking?t('digitalPerson.statusRunning'):profile.proactive_enabled?`${profile.proactive_interval_minutes ?? 30} ${t('digitalPerson.minuteUnit')}`:t('digitalPerson.disabled')}</span></div>
      <dl className="digital-console-check-summary"><div><dt>{t('digitalPerson.lastCheck')}</dt><dd>{time(latest?.created_at)}</dd></div><div><dt>{t('digitalPerson.checkResult')}</dt><dd>{latest?status(latest.status):t('digitalPerson.noRuns')}</dd></div></dl>
      <Button data-console-check variant="ghost" loading={checking} disabled={checking || activity?.checking} onClick={()=>void check()}><Icon name="refresh" size={14}/>{t('digitalPerson.checkNow')}</Button>
      {(checking || activity?.checking) && <Button variant="ghost" onClick={()=>void digitalRuntimeApi.stop().catch(e=>setError(String(e)))}>{t('common.stop')}</Button>}
    </section>
    <section className="digital-console-section">
      <div className="digital-console-section-heading"><Icon name="workflow" size={15}/><h3>{t('digitalPerson.delegations')}</h3><span>{pending.length}</span></div>
      {!activity?.delegations.length && <p className="digital-console-empty">{t('digitalPerson.noDelegations')}</p>}
      {activity?.delegations.slice(-4).reverse().map(item=><button className="digital-console-work" key={item.id} onClick={()=>openWork(item)}><span>{item.instruction}</span><small>{item.status==='running'?t('digitalPerson.workRunning'):status(item.status)}</small><Icon name="chevron-right" size={14}/></button>)}
    </section>
    <section className="digital-console-section">
      <div className="digital-console-section-heading"><Icon name="clock" size={15}/><h3>{t('digitalPerson.activity')}</h3></div>
      {!activity?.runs.length && <p className="digital-console-empty">{t('digitalPerson.noRuns')}</p>}
      {activity?.runs.slice(0,4).map(run=><details className="digital-console-event" key={run.id}><summary><span>{status(run.status)}</span><time>{time(run.created_at)}</time></summary><p>{run.summary || run.error || t('digitalPerson.checkQuiet')}</p></details>)}
    </section>
  </div>
  return <div className="digital-person-workspace" data-state={state}>
    <div className="digital-console-presence">
      {core}<div><strong>{profile.name}</strong><span>{t(`digitalPerson.presence${state.charAt(0).toUpperCase()+state.slice(1)}` as never)}</span></div>
      <Button data-console-listen variant="ghost" className="digital-console-icon" loading={startingVoice} aria-label={t(listening?'digitalPerson.stopListening':'digitalPerson.voiceWakeAction')} title={t(listening?'digitalPerson.stopListening':'digitalPerson.voiceWakeAction')} aria-pressed={listening} onClick={()=>void listen()}><Icon name="mic" size={18}/></Button>
      <Button variant="ghost" className="digital-console-icon" aria-label={t('digitalPerson.activity')} onClick={()=>setDetails(true)}><Icon name="sliders-horizontal" size={18}/></Button>
    </div>
    {(error || wakeError) && <div role="alert" className="digital-console-feedback digital-console-error">{error || wakeError}</div>}
    {!error && !wakeError && notice && <div role="status" className="digital-console-feedback">{notice}</div>}
    <div className="digital-console-layout">
      <aside className="digital-console-identity" aria-label={t('digitalPerson.identity')}>
        <div className="digital-console-brand"><Icon name="layers" size={18}/><span>WORKSTEP</span></div>
        <div className="digital-console-core-stage">{core}</div>
        <h2>{profile.name}</h2><p className="digital-console-role">{profile.role}</p>
        <div className="digital-console-presence-label"><span/>{t(`digitalPerson.presence${state.charAt(0).toUpperCase()+state.slice(1)}` as never)}</div>
        <div className="digital-console-growth"><span>Lv.{activity?.level ?? 1}</span><progress value={activity?.experience ?? 0} max={activity?.next_level_experience ?? 10}/><small>{activity?.experience ?? 0}</small></div>
        <div className="digital-console-identity-footer"><Icon name="shield" size={14}/><span>{t('digitalPerson.deviceCompanion')}</span></div>
      </aside>
      <main className="digital-console-conversation">{children}</main>
      <aside className="digital-console-monitor" aria-label={t('digitalPerson.activity')}>{inspector}</aside>
    </div>
    <MobileSheet open={details} title={t('digitalPerson.activity')} onClose={()=>setDetails(false)}>{inspector}</MobileSheet>
  </div>
}
