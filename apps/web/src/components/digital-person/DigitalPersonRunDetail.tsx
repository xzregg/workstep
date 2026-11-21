import { useEffect, useState } from 'react'
import { digitalRuntimeApi, type DigitalRunDetail } from '../../api/digitalPerson'
import { useI18n, localizeErrorDisplay } from '../../i18n'
import Button from '../Button'
import Spinner from '../Spinner'
import DigitalPersonRunOutcome from './DigitalPersonRunOutcome'
import {useDigitalRunProcessing} from './useDigitalRunProcessing'
import './DigitalPersonRunDetail.css'

const deliveryStatus = {
  notify:'digitalPerson.statusNotify', notifying:'digitalPerson.statusNotifying',
  notified:'digitalPerson.statusNotified', delivery_failed:'digitalPerson.statusDelivery_failed',
} as const

export default function DigitalPersonRunDetail({id, busy, onRetryDelivery}: {
  id: string; busy: boolean; onRetryDelivery?: () => Promise<void>
}) {
  const {t,errorText}=useI18n()
  const formatProcessing=useDigitalRunProcessing()
  const [data,setData]=useState<DigitalRunDetail | null>(null)
  const [error,setError]=useState(''), [revision,setRevision]=useState(0)
  useEffect(()=>{
    let active=true
    setError('');setData(null)
    void digitalRuntimeApi.runDetail(id).then(result=>{if(active)setData(result)},reason=>{if(active)setError(String(reason))})
    return()=>{active=false}
  },[id,revision])
  const thought=data?.summary||data?.draft_summary
  const message=data?.notification_message
  const statusLabel=deliveryStatus[data?.status as keyof typeof deliveryStatus]??'digitalPerson.runNoMessageSent'
  return <div className="digital-person-run-detail" id={`digital-run-${id}`}>
    {!data && !error && <Spinner/>}
    {error && <><p role="alert">{localizeErrorDisplay(error)}</p><Button variant="ghost" onClick={()=>setRevision(v=>v+1)}>{t('common.retry')}</Button></>}
    {data && <>
      {(data.processing||data.outcome)&&<div className="digital-person-run-summary">
        {data.processing&&<p>{formatProcessing(data.processing)}</p>}
        <DigitalPersonRunOutcome outcome={data.outcome} section="affinity"/>
      </div>}
      {!message&&(thought?<>{data.status==='failed'&&<strong>{t('digitalPerson.runThoughtContent')}</strong>}<p>{thought}</p></>:data.status==='failed'&&<p>{t('digitalPerson.runNoSavedContent')}</p>)}
      {message&&<p className="digital-person-run-message">{message}</p>}
      {message&&(!data.outcome||data.status==='notifying'||data.status==='notify')
        ?<p className="digital-person-run-delivery">{t(statusLabel)}</p>
        :<DigitalPersonRunOutcome outcome={data.outcome} section="delivery"/>}
      {message&&thought&&thought!==message&&<p>{thought}</p>}
      {data.error && <div className="digital-person-run-error" role="alert"><strong>{t('digitalPerson.runFailureLabel')}</strong><p>{data.failure_reason ? errorText(data.failure_reason) : data.error==='检查结果来源无效' ? t('digitalPerson.runSourceMismatch') : errorText(data.error)}</p></div>}
      {data.status==='delivery_failed' && onRetryDelivery && <Button data-retry-delivery variant="ghost" loading={busy} disabled={busy} onClick={async()=>{await onRetryDelivery();setRevision(v=>v+1)}}>{t('common.retry')}</Button>}
    </>}
  </div>
}
