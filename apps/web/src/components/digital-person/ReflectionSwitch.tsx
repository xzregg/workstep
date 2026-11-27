import {useEffect, useRef, useState} from 'react'
import {digitalPersonApi, type DigitalPersonProfile} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import Spinner from '../Spinner'
import {DIGITAL_PERSON_CHANGED} from './useDigitalPerson'

/** An immediate setting: display only server-confirmed state. */
export default function ReflectionSwitch(){
 const {t}=useI18n()
 const [profile,setProfile]=useState<DigitalPersonProfile|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const alive=useRef(true),saving=useRef(false)
 useEffect(()=>{
  alive.current=true
  let pending=false,queued=false
  const load=async()=>{
   if(saving.current)return
   if(pending){queued=true;return}
   pending=true
   try{const value=await digitalPersonApi.get();if(alive.current&&!saving.current){setProfile(value);setError(previous=>previous===t('digitalPerson.reflectionLoadFailed')?'':previous)}}
   catch{if(alive.current){setProfile(null);setError(t('digitalPerson.reflectionLoadFailed'))}}
   finally{pending=false;if(queued&&alive.current){queued=false;void load()}}
  }
  void load()
  window.addEventListener(DIGITAL_PERSON_CHANGED,load)
  window.addEventListener('workstep:reconnected',load)
  window.addEventListener('focus',load)
  return()=>{alive.current=false;window.removeEventListener(DIGITAL_PERSON_CHANGED,load);window.removeEventListener('workstep:reconnected',load);window.removeEventListener('focus',load)}
 },[t])
 const toggle=async()=>{
  if(!profile||saving.current)return
  const enabled=!(profile.reflection_enabled??true)
  saving.current=true;setBusy(true);setError('')
  try{
   const latest=await digitalPersonApi.get()
   const saved=await digitalPersonApi.save({...latest,reflection_enabled:enabled})
   if(alive.current)setProfile(saved)
  }catch{if(alive.current)setError(t('digitalPerson.reflectionSaveFailed'))}
  finally{
   saving.current=false
   if(alive.current){setBusy(false);window.dispatchEvent(new Event(DIGITAL_PERSON_CHANGED))}
  }
 }
 return <>
  <div className="digital-reflection-control">
   {busy&&<Spinner/>}
   <button type="button" className="settings-switch" role="switch" aria-label={t('digitalPerson.homeReflection')}
    title={t('digitalPerson.homeReflection')} aria-checked={profile?(profile.reflection_enabled??true):false}
    disabled={!profile||busy} aria-busy={busy} onClick={()=>void toggle()}><span className="settings-switch-thumb"/></button>
  </div>
  {error&&<span className="digital-reflection-error" role="alert">{error}</span>}
 </>
}
