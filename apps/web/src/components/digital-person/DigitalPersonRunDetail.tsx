import { useEffect, useState } from 'react'
import { digitalRuntimeApi, type DigitalRunDetail } from '../../api/digitalPerson'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Spinner from '../Spinner'
import DigitalPersonRunOutcome from './DigitalPersonRunOutcome'

export default function DigitalPersonRunDetail({id, busy, onRetryDelivery}: {
  id: string; busy: boolean; onRetryDelivery?: () => Promise<void>
}) {
  const {t}=useI18n()
  const [data,setData]=useState<DigitalRunDetail | null>(null)
  const [error,setError]=useState(''), [revision,setRevision]=useState(0)
  useEffect(()=>{
    let active=true
    setError('');setData(null)
    void digitalRuntimeApi.runDetail(id).then(result=>{if(active)setData(result)},reason=>{if(active)setError(String(reason))})
    return()=>{active=false}
  },[id,revision])
  return <div className="digital-person-run-detail" id={`digital-run-${id}`}>
    {!data && !error && <Spinner/>}
    {error && <><p role="alert">{error}</p><Button variant="ghost" onClick={()=>setRevision(v=>v+1)}>{t('common.retry')}</Button></>}
    {data && <>
      {(data.summary||data.draft_summary)?<>{data.status==='failed'&&<strong>{t('digitalPerson.runThoughtContent')}</strong>}<p>{data.summary||data.draft_summary}</p></>:data.status==='failed'&&<p>{t('digitalPerson.runNoSavedContent')}</p>}
      <DigitalPersonRunOutcome outcome={data.outcome}/>
      {data.error && <div className="digital-person-run-error" role="alert"><strong>{t('digitalPerson.runFailureLabel')}</strong><p>{data.failure_reason||(data.error==='检查结果来源无效'?t('digitalPerson.runSourceMismatch'):data.error)}</p></div>}
      {data.status==='delivery_failed' && onRetryDelivery && <Button data-retry-delivery variant="ghost" loading={busy} disabled={busy} onClick={async()=>{await onRetryDelivery();setRevision(v=>v+1)}}>{t('common.retry')}</Button>}
    </>}
  </div>
}
