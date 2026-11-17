import type {DigitalRunOutcome} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import Icon from '../Icon'
import './DigitalPersonRunOutcome.css'

export default function DigitalPersonRunOutcome({outcome}:{outcome?:DigitalRunOutcome|null}){
 const {t}=useI18n()
 if(!outcome)return null
 return <span className="digital-run-outcome">
  <span><Icon name="send" size={14}/>{outcome.sent?t('digitalPerson.runMessagesSent',{count:outcome.sent}):t('digitalPerson.runNoMessageSent')}</span>
  {outcome.message_preview&&<small className="digital-run-outcome-preview">{outcome.message_preview}</small>}
  {outcome.failed>0&&<span className="digital-run-outcome-failed"><Icon name="circle-alert" size={14}/>{t('digitalPerson.runMessagesFailed',{count:outcome.failed})}</span>}
  {outcome.affinity_increased>0&&<span className="digital-run-outcome-up"><Icon name="heart" size={14}/>{t('digitalPerson.runAffinityUp',{count:outcome.affinity_increased})}</span>}
  {outcome.affinity_decreased>0&&<span className="digital-run-outcome-down"><Icon name="heart" size={14}/>{t('digitalPerson.runAffinityDown',{count:outcome.affinity_decreased})}</span>}
  {!outcome.affinity_increased&&!outcome.affinity_decreased&&<span><Icon name="heart" size={14}/>{t('digitalPerson.runAffinityUnchanged')}</span>}
 </span>
}
