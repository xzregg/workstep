import type {DigitalRunDetail, DigitalRunOutcome} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import Icon from '../Icon'
import './DigitalPersonRunOutcome.css'

export function DigitalPersonRunDelivery({run, summaryInList}: {run: DigitalRunDetail; summaryInList?: string}) {
 const {t,errorText}=useI18n()
 const {status,outcome}=run
 const failed=status==='delivery_failed'||!!outcome?.failed
 const pending=status==='notify'||status==='notifying'||status==='deferred'
 const sent=outcome?.sent ?? 0
 const reasons=outcome?.delivery_failure_reasons?.filter(reason=>reason.trim()) ?? []
 if (!reasons.length && status==='delivery_failed' && run.error?.trim()) reasons.push(run.error)
 const label=status==='silent' ? (run.summary?.trim() === summaryInList?.trim() ? '' : run.summary)
  : status==='notify' ? t('digitalPerson.statusNotify')
  : status==='notifying' ? t('digitalPerson.statusNotifying')
  : status==='deferred' ? t('digitalPerson.statusDeferred')
  : sent ? t('digitalPerson.runMessagesSent',{count:sent})
  : status==='notified' ? t('digitalPerson.statusNotified') : ''
 if (!label && !failed) return null
 return <div className="digital-run-outcome digital-run-notification">
  {label&&<span><Icon name={status==='notifying'?'loader-circle':status==='silent'?'lightbulb':'send'} size={14} className={status==='notifying'?'task-status-spinner':undefined}/><span>{label}</span></span>}
  {failed&&!pending&&<span className="digital-run-outcome-failed" role="alert">
   <Icon name="circle-alert" size={14}/><span>{t('digitalPerson.runNotificationFailed')} · {
    reasons.length ? reasons.map(reason=>errorText(reason)).join(' · ') : t('digitalPerson.runNotificationReasonMissing')
   }</span>
  </span>}
 </div>
}

export default function DigitalPersonRunOutcome({outcome}:{outcome?:DigitalRunOutcome|null}){
 const {t}=useI18n()
 if(!outcome)return null
 return <span className="digital-run-outcome">
   {outcome.affinity_increased>0&&<span className="digital-run-outcome-up"><Icon name="heart" size={14}/>{t('digitalPerson.runAffinityUp',{count:outcome.affinity_increased})}</span>}
   {outcome.affinity_decreased>0&&<span className="digital-run-outcome-down"><Icon name="heart" size={14}/>{t('digitalPerson.runAffinityDown',{count:outcome.affinity_decreased})}</span>}
   {!outcome.affinity_increased&&!outcome.affinity_decreased&&<span><Icon name="heart" size={14}/>{t('digitalPerson.runAffinityUnchanged')}</span>}
 </span>
}
