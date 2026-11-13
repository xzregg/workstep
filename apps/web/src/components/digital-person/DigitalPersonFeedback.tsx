import { DIGITAL_ACTIVITY_CHANGED } from './useDigitalActivity'
import { useEffect, useState } from 'react'
import { digitalRuntimeApi } from '../../api/digitalPerson'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import './DigitalPersonFeedback.css'

export default function DigitalPersonFeedback({messageId,initialValue=0}:{messageId:string;initialValue?:number}) {
  const {t}=useI18n()
  const [value,setValue]=useState(initialValue),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState(0)
  useEffect(()=>setValue(initialValue),[initialValue])
  const vote=async(next:number)=>{if(busy)return;setPending(next || value);setBusy(true);setError('');try{await digitalRuntimeApi.feedback(messageId,next);setValue(next);window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED))}catch(e){setError(String(e))}finally{setBusy(false)}}
  return <span className="digital-person-feedback" role="group" aria-label={t('digitalPerson.feedback')}>
    {([1,-1] as const).map(voteValue=><Button key={voteValue} variant="ghost" className="chat-message-action digital-person-feedback-button" disabled={busy} loading={busy && pending===voteValue} aria-label={t(voteValue===1?'digitalPerson.helpful':'digitalPerson.unhelpful')} title={t(voteValue===1?'digitalPerson.helpful':'digitalPerson.unhelpful')} aria-pressed={value===voteValue} onClick={()=>void vote(value===voteValue?0:voteValue)}>{!(busy && pending===voteValue) && <Icon name={voteValue===1?'thumbs-up':'thumbs-down'} size={14}/>}</Button>)}
    {error && <span role="alert" className="digital-person-feedback-error">{t('digitalPerson.feedbackFailed')}</span>}
  </span>
}
