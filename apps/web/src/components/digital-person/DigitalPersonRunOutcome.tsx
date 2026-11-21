import type {DigitalRunOutcome} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import Icon from '../Icon'
import './DigitalPersonRunOutcome.css'

export default function DigitalPersonRunOutcome({outcome,section='all'}:{outcome?:DigitalRunOutcome|null;section?:'all'|'affinity'|'delivery'}){
 const {t}=useI18n()
 if(!outcome)return null
 return <span className="digital-run-outcome">
  {section!=='affinity'&&<>
   {(outcome.sent>0||!outcome.failed)&&<span><Icon name="send" size={14}/>{outcome.sent?t('digitalPerson.runMessagesSent',{count:outcome.sent}):t('digitalPerson.runNoMessageSent')}</span>}
   {outcome.failed>0&&<span className="digital-run-outcome-failed"><Icon name="circle-alert" size={14}/><span>{outcome.delivery_failure_reasons?.join(' · ')||t('digitalPerson.runMessagesFailed',{count:outcome.failed})}</span></span>}
  </>}
  {section!=='delivery'&&<>
   {outcome.affinity_increased>0&&<span className="digital-run-outcome-up"><Icon name="heart" size={14}/>{t('digitalPerson.runAffinityUp',{count:outcome.affinity_increased})}</span>}
   {outcome.affinity_decreased>0&&<span className="digital-run-outcome-down"><Icon name="heart" size={14}/>{t('digitalPerson.runAffinityDown',{count:outcome.affinity_decreased})}</span>}
   {!outcome.affinity_increased&&!outcome.affinity_decreased&&<span><Icon name="heart" size={14}/>{t('digitalPerson.runAffinityUnchanged')}</span>}
  </>}
 </span>
}
