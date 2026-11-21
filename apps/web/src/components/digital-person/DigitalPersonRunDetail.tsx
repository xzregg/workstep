import { useEffect, useState } from 'react'
import { digitalRuntimeApi, type DigitalRunDetail } from '../../api/digitalPerson'
import { useI18n, localizeErrorDisplay } from '../../i18n'
import Button from '../Button'
import Spinner from '../Spinner'
import DigitalPersonRunOutcome, {DigitalPersonRunDelivery} from './DigitalPersonRunOutcome'
import DigitalPersonRunKnowledge, {DigitalPersonProcessedSources} from './DigitalPersonRunKnowledge'
import './DigitalPersonRunDetail.css'

export default function DigitalPersonRunDetail({id, busy, processingInList, onRetryDelivery}: {
  id: string; busy: boolean; processingInList?: boolean; onRetryDelivery?: () => Promise<void>
}) {
  const {t,errorText}=useI18n()
  const [data,setData]=useState<DigitalRunDetail | null>(null)
  const [error,setError]=useState(''), [revision,setRevision]=useState(0)
  useEffect(()=>{
    let active=true
    setError('');setData(null)
    void digitalRuntimeApi.runDetail(id).then(result=>{if(active)setData(result)},reason=>{if(active)setError(String(reason))})
    return()=>{active=false}
  },[id,revision])
  const thought=(data?.status==='silent'?'':data?.summary)||data?.draft_summary
  const message=data?.notification_message
  const processing=data?.processing
  return <div className="digital-person-run-detail" id={`digital-run-${id}`}>
    {!data && !error && <Spinner/>}
    {error && <><p role="alert">{localizeErrorDisplay(error)}</p><Button variant="ghost" onClick={()=>setRevision(v=>v+1)}>{t('common.retry')}</Button></>}
    {data && <>
      {(processing||data.outcome)&&<div className="digital-person-run-summary">
        {processing&&processingInList&&<DigitalPersonProcessedSources processing={processing}/>}
        {processing&&!processingInList&&<DigitalPersonRunKnowledge runId={id} processing={processing}>
          {summary=><p>{summary}</p>}
        </DigitalPersonRunKnowledge>}
        <DigitalPersonRunOutcome outcome={data.outcome}/>
      </div>}
      {!message&&(thought?<>{data.status==='failed'&&<strong>{t('digitalPerson.runThoughtContent')}</strong>}<p>{thought}</p></>:data.status==='failed'&&<p>{t('digitalPerson.runNoSavedContent')}</p>)}
      {message&&<p className="digital-person-run-message">{message}</p>}
      {message&&thought&&thought!==message&&<p>{thought}</p>}
      <DigitalPersonRunDelivery run={data}/>
      {data.error && data.status!=='delivery_failed' && <div className="digital-person-run-error" role="alert"><strong>{t('digitalPerson.runFailureLabel')}</strong><p>{data.failure_reason ? errorText(data.failure_reason) : data.error==='检查结果来源无效' ? t('digitalPerson.runSourceMismatch') : errorText(data.error)}</p></div>}
      {data.status==='delivery_failed' && onRetryDelivery && <Button data-retry-delivery variant="ghost" loading={busy} disabled={busy} onClick={async()=>{await onRetryDelivery();setRevision(v=>v+1)}}>{t('common.retry')}</Button>}
    </>}
  </div>
}
