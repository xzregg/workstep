import {useEffect, useRef} from 'react'
import {useNavigate} from 'react-router-dom'
import {useVoiceInput} from '../../hooks/useVoiceInput'
import {resolveDigitalPersonChat} from './digitalPersonChat'
import {useProjectStore} from '../../stores/projectStore'
import {useI18n} from '../../i18n'
import {useGatewayProjectPermissions} from '../../hooks/useGatewayProjectPermissions'
import {digitalPersonApi} from '../../api/digitalPerson'
import {DIGITAL_PERSON_CHANGED,useDigitalPerson} from './useDigitalPerson'
import {useWakeState,wakeMatches,type WakeSensitivity} from './digitalPersonWakeState'
import Button from '../Button'
export {wakeMatches} from './digitalPersonWakeState'

export function DigitalPersonWakeController(){
 const {t}=useI18n(),navigate=useNavigate()
 const home=useProjectStore(s=>s.projects.find(p=>p.is_default_workspace && p.type!=='remote'))
 const {bound}=useGatewayProjectPermissions(home?.id)
 const {listening,keyword,sensitivity}=useWakeState()
 const profile=useDigitalPerson(Boolean(listening && home && !bound))
 const triggered=useRef(false)
 const voice=useVoiceInput({ownerKey:'digital-person-wake',projectId:home?.id,disabled:!home||bound,compact:false,value:'',cursor:0,onInsert:()=>{}})
 useEffect(()=>{useWakeState.setState({phase:listening?voice.phase:'idle'})},[listening,voice.phase])
 useEffect(()=>{
  if(!listening){triggered.current=false;voice.cancel();return}
  if(!profile||!home||bound)return
  if(wakeMatches(voice.text,keyword,sensitivity) && !triggered.current){
   triggered.current=true;useWakeState.setState({listening:false});voice.cancel()
   void resolveDigitalPersonChat(home.id).then(id=>{
    useProjectStore.getState().setActiveProject(home)
    navigate(`/chat?project=${encodeURIComponent(home.name)}&session=${id}`)
   }).catch(e=>useWakeState.setState({error:String(e)}))
  }else if(voice.phase==='recording' && voice.seconds>=20)void voice.finish()
  else if(voice.phase==='idle')void voice.start()
  else if(voice.phase==='error')useWakeState.setState({listening:false,error:voice.error?t(voice.error as never):''})
  // Capture hook owns cancellation, session limits and PCM disposal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[listening,keyword,sensitivity,voice.text,voice.phase,voice.seconds,home?.id,profile,bound])
 useEffect(()=>{
  const hide=()=>{if(document.hidden)useWakeState.setState({listening:false})}
  const changed=()=>void digitalPersonApi.get().then(p=>{if(!p.enabled)useWakeState.setState({listening:false})}).catch(()=>useWakeState.setState({listening:false}))
  window.addEventListener(DIGITAL_PERSON_CHANGED,changed)
  document.addEventListener('visibilitychange',hide)
  return()=>{window.removeEventListener(DIGITAL_PERSON_CHANGED,changed);document.removeEventListener('visibilitychange',hide);useWakeState.setState({listening:false})}
 },[])
 return listening?<div className="digital-person-listening" role="status"><span>{t(voice.phase==='recording'?'digitalPerson.listening':'digitalPerson.presenceStarting')}</span><Button onClick={()=>useWakeState.setState({listening:false})}>{t('digitalPerson.stopListening')}</Button></div>:null
}
export default function DigitalPersonWake({keyword='',sensitivity='balanced'}:{keyword?:string;sensitivity?:WakeSensitivity}){
 const {t}=useI18n()
 const home=useProjectStore(s=>s.projects.find(p=>p.is_default_workspace && p.type!=='remote'))
 const {listening,error}=useWakeState()
 return <div className="voice-wake-settings"><Button role="switch" aria-checked={listening} disabled={!home||!keyword} onClick={()=>{if(listening){useWakeState.setState({listening:false});return}void digitalPersonApi.get().then(p=>{if(!p.enabled)throw new Error(t('digitalPerson.enableFirst'));useWakeState.setState({listening:true,keyword,sensitivity,error:''})}).catch(e=>useWakeState.setState({error:String(e)}))}}>{t(listening?'digitalPerson.stopListening':'digitalPerson.startListening')}</Button><p>{t('digitalPerson.wakeLocalHint',{keyword})}</p>{error&&<p role="alert">{error}</p>}</div>
}
