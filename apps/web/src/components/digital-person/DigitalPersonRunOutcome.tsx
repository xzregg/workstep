import type {DigitalRunDetail, DigitalRunOutcome,DigitalRunNotification} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import Icon from '../Icon'
import './DigitalPersonRunOutcome.css'

const reasonKeys:Record<string,string>={
 model_silent:'ModelSilent',no_work:'NoWork',internal_only:'InternalOnly',proactive_disabled:'ProactiveDisabled',
 archived_source:'ArchivedSource',contact_policy:'ContactPolicy',source_busy:'SourceBusy',duplicate:'Duplicate',
 disabled:'Disabled',quiet_hours:'QuietHours',face_welcome:'FaceWelcome',target_missing:'TargetMissing',
 stale_result:'StaleResult',invalid_evidence:'InvalidEvidence',action_not_applicable:'ActionNotApplicable',
 delivered:'Delivered',delivery_failed:'DeliveryFailed',no_targets:'NoTargets',assessment_failed:'AssessmentFailed',receipt_unavailable:'ReceiptUnavailable',
}

export function DigitalPersonRunNotificationStatus({run}:{run:DigitalRunDetail}){
 const {t}=useI18n()
 const notices=run.delegation_notifications ?? []
 const state=notices.find(item=>['deferred','delivery_failed','suppressed'].includes(item.state))?.state ?? notices[0]?.state ?? run.notification?.state ?? 'unknown'
 const key=state==='notified'?'statusNotified':state==='deferred'?'statusDeferred':state==='notifying'?'statusNotifying':state==='delivery_failed'?'runNotificationFailed':'statusSilent'
 return <>{t(`digitalPerson.${key}` as never)}</>
}

export function DigitalPersonRunNotificationReasons({run}:{run:DigitalRunDetail}){
 const {t}=useI18n()
 const explain=(item:DigitalRunNotification)=>{
  const reason=item.reason,modelReason=item.model_reason?.trim()
  if(!Object.hasOwn(reasonKeys,reason)||(reason==='model_silent'&&!modelReason))return null
  const category=reason==='model_silent'?'Llm':reason==='quiet_hours'?'Quiet':reason==='delivery_failed'?'Error'
   : reason==='target_missing'?'Target':reason==='no_targets'?'Receipt': reason==='receipt_unavailable'?'Unknown'
   : reason==='delivered'?'Delivered':reason==='assessment_failed'?'Assessment':['no_work','internal_only'].includes(reason)?'Internal': 'Policy'
  const description=reason==='model_silent'?t('digitalPerson.notificationModelReason',{reason:modelReason!})
   :t(`digitalPerson.notificationReason${reasonKeys[reason]}` as never)
  return <>{t(`digitalPerson.notificationCategory${category}` as never)} · {description}{reason!=='model_silent'&&modelReason&&<> · {t('digitalPerson.notificationModelReason',{reason:modelReason!})}</>}</>
 }
 const primary=explain(run.notification??(run.status==='delivery_failed'||!!run.outcome?.failed?{state:'delivery_failed',reason:'delivery_failed'}:{state:'unknown',reason:'unknown'}))
 const notices=(run.delegation_notifications??[]).map(explain).filter(item=>item!==null)
 if(!primary&&!notices.length)return null
 return <div className="digital-run-outcome digital-run-notification-reasons">
  {primary&&<span className="digital-run-notification-audit">{primary}</span>}
  {notices.map((notice,index)=><span className="digital-run-notification-audit" key={index}>{t('digitalPerson.notificationDelegation')} · {notice}</span>)}
 </div>
}

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
 const audit=run.notification
 const failureDetail=reasons.length ? reasons.map(reason=>errorText(reason)).join(' · ')
  : audit?.reason==='no_targets' ? t('digitalPerson.notificationReasonNoTargets') : ''
 return <div className="digital-run-outcome digital-run-notification">
  {label&&<span><Icon name={status==='notifying'?'loader-circle':status==='silent'?'lightbulb':'send'} size={14} className={status==='notifying'?'task-status-spinner':undefined}/><span>{label}</span></span>}
  {status!=='running'&&<DigitalPersonRunNotificationReasons run={run}/>}
  {failed&&!pending&&<span className="digital-run-outcome-failed" role="alert">
   <Icon name="circle-alert" size={14}/><span>{t('digitalPerson.runNotificationFailed')}{failureDetail&&<> · {failureDetail}</>}</span>
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
