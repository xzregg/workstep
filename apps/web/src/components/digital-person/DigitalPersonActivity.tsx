import { useNavigate } from 'react-router-dom'
import { useProjectStore } from '../../stores/projectStore'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { digitalRuntimeApi, type DigitalActivityRecords } from '../../api/digitalPerson'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import StatusBadge from '../StatusBadge'
import { DIGITAL_ACTIVITY_CHANGED } from './useDigitalActivity'
import Spinner from '../Spinner'
import DigitalPersonRunDetail from './DigitalPersonRunDetail'
import './DigitalPersonActivity.css'

const PAGE_SIZE = 5

function ActivitySection({kind, title, total, page, loading, onPage, children}: {
  kind: string; title: string; total: number; page: number; loading: boolean
  onPage: (page: number) => void; children: ReactNode
}) {
  const {t} = useI18n()
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return <section className="digital-person-activity-section" data-kind={kind} aria-label={title}>
    <header><h3>{title}<span>{total}</span></h3>
      {pages > 1 && <nav className="digital-person-activity-pagination" aria-label={title}>
        <span>{page + 1} / {pages}</span>
        <Button variant="ghost" className="digital-person-activity-icon" disabled={loading || page === 0} aria-label={t('digitalPerson.previousPage')} title={t('digitalPerson.previousPage')} onClick={()=>onPage(page - 1)}><Icon name="chevron-left" size={14}/></Button>
        <Button data-next-page variant="ghost" className="digital-person-activity-icon" disabled={loading || page + 1 >= pages} aria-label={t('digitalPerson.nextPage')} title={t('digitalPerson.nextPage')} onClick={()=>onPage(page + 1)}><Icon name="chevron-right" size={14}/></Button>
      </nav>}
    </header>
    <div className="digital-person-activity-list">{children}</div>
  </section>
}

export default function DigitalPersonActivity({onNavigate, checking = false, titleId}: {onNavigate?:()=>void; checking?:boolean; titleId?:string}) {
  const {t, locale} = useI18n(), navigate = useNavigate()
  const projects = useProjectStore(s=>s.projects)
  const [data, setData] = useState<DigitalActivityRecords | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(false), [revision, setRevision] = useState(0)
  const [runPage, setRunPage] = useState(0), [delegationPage, setDelegationPage] = useState(0)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const polling = useRef(false)
  useEffect(() => {
    let active = true, pending = false
    const load = async () => {
      if(pending) return
      pending = true; setLoading(true)
      try {
        const result = await digitalRuntimeApi.records(runPage * PAGE_SIZE, delegationPage * PAGE_SIZE)
        if(active) {
          setData(result); setError('')
          polling.current = result.checking || result.delegation_pending === true
          if(delegationPage && delegationPage * PAGE_SIZE >= result.delegation_total) setDelegationPage(Math.max(0, Math.ceil(result.delegation_total / PAGE_SIZE) - 1))
          if(runPage && runPage * PAGE_SIZE >= result.run_total) setRunPage(Math.max(0, Math.ceil(result.run_total / PAGE_SIZE) - 1))
        }
      } catch(e) {if(active) setError(String(e))}
      finally {pending = false; if(active) setLoading(false)}
    }
    window.addEventListener(DIGITAL_ACTIVITY_CHANGED, load)
    void load()
    const timer = window.setInterval(()=>{if(polling.current && !document.hidden) void load()},15000)
    return () => {active = false; window.removeEventListener(DIGITAL_ACTIVITY_CHANGED,load); window.clearInterval(timer)}
  }, [revision, runPage, delegationPage])
  const action = async (key: string, fn: () => Promise<unknown>) => {
    if(busy) return
    setBusy(key); setError('')
    try {await fn(); setRevision(v=>v+1)} catch(e) {setError(String(e))} finally {setBusy('')}
  }
  const status=(value:string)=>t(`digitalPerson.status${value.charAt(0).toUpperCase()+value.slice(1)}` as never)
  const badge=(value:string)=><StatusBadge status={value} label={status(value)} loading={['running','notifying'].includes(value)}/>
  const openWork=(item:DigitalActivityRecords['delegations'][number])=>{
    const project=projects.find(p=>p.id===item.project_id)
    if(!project){setError(t('digitalPerson.projectUnavailable'));return}
    useProjectStore.getState().setActiveProject(project)
    navigate(`/chat?project=${encodeURIComponent(project.name)}&session=${encodeURIComponent(item.session_id)}`)
    onNavigate?.()
  }
  const timestamp=(value:string)=>{
    const date=new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})
  }
  const refreshButton = <Button variant="ghost" className="digital-person-activity-icon digital-person-refresh" disabled={!!busy || loading} aria-label={t('settings.refresh')} title={t('settings.refresh')} onClick={()=>setRevision(v=>v+1)}>{loading?<Spinner size={14}/>:<Icon name="refresh" size={16}/>}</Button>
  return <div className="digital-person-activity" aria-busy={loading}>
    {titleId && <header className="digital-person-activity-header settings-heading-row"><h2 id={titleId}>{t('digitalPerson.activity')}</h2>{refreshButton}</header>}
    <div className="digital-person-activity-toolbar">
      <Button variant="primary" loading={checking || busy==='check' || data?.checking} disabled={checking || !!busy || data?.checking} onClick={()=>void action('check',()=>digitalRuntimeApi.check())}>{t('digitalPerson.thinkNow')}</Button>
      {(checking || busy==='check' || data?.checking) && <Button variant="ghost" onClick={()=>void digitalRuntimeApi.stop().catch(e=>setError(String(e)))}>{t('common.stop')}</Button>}
      {!titleId && refreshButton}
    </div>
    {error && <p role="alert" className="digital-person-run-error">{error}</p>}
    {!data && !error && <Spinner/>}
    {data && <>
      <ActivitySection kind="delegations" title={t('digitalPerson.delegationNotifications')} total={data.delegation_total} page={delegationPage} loading={loading || !!busy} onPage={setDelegationPage}>
        {!data.delegations.length && <p className="digital-person-activity-empty">{t('digitalPerson.noDelegationNotifications')}</p>}
        {data.delegations.map(item=><div className="digital-person-delegation-row" key={item.id}>
          <Button data-open-execution variant="ghost" className="digital-person-activity-open" title={t('digitalPerson.viewExecution')} onClick={()=>openWork(item)}><span className="digital-person-activity-title">{item.instruction}</span><Icon name="external-link" size={14}/></Button>
          <div className="digital-person-activity-row-actions">
            <span title={item.notification_state==='read'?t('digitalPerson.notificationRead'):item.notification_state==='deferred'?t('digitalPerson.notificationDeferred'):['delivery_failed','failed','interrupted'].includes(item.notification_state || '')?t('digitalPerson.notificationFailed'):undefined}>
              <StatusBadge status={item.notification_state==='notified'?'succeeded':['delivery_failed','failed','interrupted'].includes(item.notification_state || '')?'failed':'queued'}
                label={t(item.notification_state==='notified'?'digitalPerson.statusNotified':'digitalPerson.notificationPending')} loading={item.notification_state==='notifying'}/>
            </span>
            <span className="digital-person-activity-stop">
              {item.notification_state==='delivery_failed' && item.notification_run_id && <Button data-retry-delivery variant="ghost" className="digital-person-activity-icon" loading={busy===item.id} disabled={!!busy} aria-label={t('digitalPerson.retryNotification')} title={t('digitalPerson.retryNotification')} onClick={()=>void action(item.id,()=>digitalRuntimeApi.retryDelivery(item.notification_run_id!))}><Icon name="refresh" size={14}/></Button>}
            </span>
          </div>
        </div>)}
      </ActivitySection>
      <ActivitySection kind="runs" title={t('digitalPerson.activity')} total={data.run_total} page={runPage} loading={loading || !!busy} onPage={page=>{setOpenRun(null);setRunPage(page)}}>
        {!data.runs.length && <p className="digital-person-activity-empty">{t('digitalPerson.noThoughtRecords')}</p>}
        {data.runs.map(run=><div className="digital-person-run" data-run-id={run.id} key={run.id}>
          <button type="button" className="digital-person-run-toggle" aria-expanded={openRun===run.id} aria-controls={`digital-run-${run.id}`} onClick={()=>setOpenRun(openRun===run.id?null:run.id)}>
            <span className="digital-person-activity-title">{run.summary || status(run.status)}</span>
            <time dateTime={run.created_at} title={new Date(run.created_at).toLocaleString()}>{timestamp(run.created_at)}</time>
            {badge(run.status)}<Icon name={openRun===run.id?'chevron-down':'chevron-right'} size={14}/>
          </button>
          {openRun===run.id && <DigitalPersonRunDetail key={run.id} id={run.id} onRetryDelivery={()=>action('retry',()=>digitalRuntimeApi.retryDelivery(run.id))} busy={!!busy}/>}
        </div>)}
      </ActivitySection>
    </>}
  </div>
}
