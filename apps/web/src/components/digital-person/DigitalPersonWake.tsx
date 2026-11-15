import {useEffect, useRef} from 'react'
import {useNavigate} from 'react-router-dom'
import {useVoiceInput} from '../../hooks/useVoiceInput'
import {useProjectStore} from '../../stores/projectStore'
import {useI18n} from '../../i18n'
import {useGatewayProjectPermissions} from '../../hooks/useGatewayProjectPermissions'
import {digitalPersonApi} from '../../api/digitalPerson'
import {speechApi} from '../../api/speech'
import {DIGITAL_PERSON_CHANGED,useDigitalPerson} from './useDigitalPerson'
import {useWakeState,wakeMatches,type WakeSensitivity} from './digitalPersonWakeState'
import Button from '../Button'
import './DigitalPersonWake.css'
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
   triggered.current=true;voice.cancel();useWakeState.setState({listening:false,activationPending:true})
   useProjectStore.getState().setActiveProject(home)
   navigate('/companion')
  }else if(voice.phase==='recording' && voice.seconds>=20)void voice.finish()
  else if(voice.phase==='idle')void voice.start()
  else if(voice.phase==='error')useWakeState.setState({listening:false,error:voice.error?t(voice.error as never):''})
  // Capture hook owns cancellation, session limits and PCM disposal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[listening,keyword,sensitivity,voice.text,voice.phase,voice.seconds,home?.id,profile,bound])
 useEffect(()=>{
  const hide=()=>{if(document.hidden)useWakeState.setState({listening:false,activationPending:false})}
  const changed=()=>void digitalPersonApi.get().then(p=>{if(!p.enabled)useWakeState.setState({listening:false,activationPending:false})}).catch(()=>useWakeState.setState({listening:false,activationPending:false}))
  const speechChanged=()=>void speechApi.status(home?.id).then(s=>{if(!s.enabled||s.ready===false||s.streaming==='final')useWakeState.setState({listening:false,activationPending:false})}).catch(()=>useWakeState.setState({listening:false,activationPending:false}))
  window.addEventListener('workstep:speech-settings-changed',speechChanged)
  window.addEventListener(DIGITAL_PERSON_CHANGED,changed)
  document.addEventListener('visibilitychange',hide)
  return()=>{window.removeEventListener('workstep:speech-settings-changed',speechChanged);window.removeEventListener(DIGITAL_PERSON_CHANGED,changed);document.removeEventListener('visibilitychange',hide);useWakeState.setState({listening:false,activationPending:false})}
 },[home?.id])
 return listening?<div className="digital-person-listening" role="status"><span>{t(voice.phase==='recording'?'digitalPerson.listening':'digitalPerson.presenceStarting')}</span><Button size="sm" onClick={()=>useWakeState.setState({listening:false,activationPending:false})}>{t('digitalPerson.stopListening')}</Button></div>:null
}
export default function DigitalPersonWake({keyword='',sensitivity='balanced',disabled=false}:{keyword?:string;sensitivity?:WakeSensitivity;disabled?:boolean}){
 const {t}=useI18n()
 const home=useProjectStore(s=>s.projects.find(p=>p.is_default_workspace && p.type!=='remote'))
 const {listening,error}=useWakeState()
 return <div className="digital-person-wake-control"><Button role="switch" aria-checked={listening} disabled={!listening&&(disabled||!home||!keyword)} onClick={()=>{if(listening){useWakeState.setState({listening:false,activationPending:false});return}void digitalPersonApi.get().then(p=>{if(!p.enabled)throw new Error(t('digitalPerson.enableFirst'));useWakeState.setState({listening:true,keyword,sensitivity,error:''})}).catch(e=>useWakeState.setState({error:String(e)}))}}>{t(listening?'digitalPerson.stopListening':'digitalPerson.startListening')}</Button><p>{t('digitalPerson.wakeLocalHint',{keyword})}</p>{error&&<p role="alert">{error}</p>}</div>
}
