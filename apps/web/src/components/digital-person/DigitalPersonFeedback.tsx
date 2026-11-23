import { DIGITAL_ACTIVITY_CHANGED } from './useDigitalActivity'
import { useEffect, useRef, useState } from 'react'
import { digitalRuntimeApi } from '../../api/digitalPerson'
import { useI18n, localizeErrorDisplay } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import { useDelayedPending } from './useDelayedPending'
import './DigitalPersonFeedback.css'

export default function DigitalPersonFeedback({messageId,initialValue=0}:{messageId:string;initialValue?:number}) {
  const {t}=useI18n()
  const [value,setValue]=useState(initialValue),[error,setError]=useState(''),[pending,setPending]=useState(0)
  const inFlight=useRef(false)
  const showPending=useDelayedPending(pending!==0)
  useEffect(()=>setValue(initialValue),[initialValue])
  const vote=async(voteValue:number)=>{
    if(inFlight.current)return
    inFlight.current=true
    const next=value===voteValue?0:voteValue
    setPending(voteValue)
    setError('')
    try{
      await digitalRuntimeApi.feedback(messageId,next)
      setValue(next)
      window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED))
    }catch(e){
      setError(e instanceof Error ? e.message : String(e))
    }finally{
      inFlight.current=false
      setPending(0)
    }
  }
  return <span className="digital-person-feedback" role="group" aria-label={t('digitalPerson.feedback')}>
    {([1,-1] as const).map(voteValue=><Button key={voteValue} variant="ghost" className="chat-message-action digital-person-feedback-button" aria-disabled={pending!==0||undefined} aria-busy={pending===voteValue} aria-label={t(voteValue===1?'digitalPerson.helpful':'digitalPerson.unhelpful')} title={t(voteValue===1?'digitalPerson.helpful':'digitalPerson.unhelpful')} aria-pressed={value===voteValue} onClick={()=>void vote(voteValue)}>{showPending&&pending===voteValue?<Spinner size={14}/>:<Icon name={voteValue===1?'thumbs-up':'thumbs-down'} size={14}/>}</Button>)}
    {error && <span role="alert" className="digital-person-feedback-error">{t('digitalPerson.feedbackFailed')}：{localizeErrorDisplay(error)}</span>}
  </span>
}
