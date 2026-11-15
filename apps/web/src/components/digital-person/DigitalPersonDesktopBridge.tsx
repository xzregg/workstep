import {useEffect, useState} from 'react'
import {useNavigate} from 'react-router-dom'
import {useProjectStore} from '../../stores/projectStore'
import {useGatewayProjectPermissions} from '../../hooks/useGatewayProjectPermissions'
import {useDigitalPerson} from './useDigitalPerson'

export const DIGITAL_PERSON_SPEAKING='workstep:digital-person-speaking'
/** Keeps the native avatar alive independently of the selected project/chat. */
export default function DigitalPersonDesktopBridge(){
 const workspace=useProjectStore(s=>s.projects.find(p=>p.is_default_workspace && p.type!=='remote'))
 const {bound}=useGatewayProjectPermissions(workspace?.id)
 const profile=useDigitalPerson(Boolean(window.workstepDesktop?.digitalPerson && workspace && !bound))
 const navigate=useNavigate(), [error,setError]=useState('')
 useEffect(()=>{
  const bridge=window.workstepDesktop?.digitalPerson
  if(!bridge)return
  const sync=(speaking=false)=>void bridge.sync({enabled:Boolean(profile?.floating),name:profile?.name,role:profile?.role,expression:profile?.expression,speaking}).catch(reason=>setError(String(reason)))
  sync()
  const speaking=(event:Event)=>sync(Boolean((event as CustomEvent<boolean>).detail))
  window.addEventListener(DIGITAL_PERSON_SPEAKING,speaking)
  return ()=>{window.removeEventListener(DIGITAL_PERSON_SPEAKING,speaking);void bridge.sync({enabled:false}).catch(()=>{})}
 },[profile])
 useEffect(()=>window.workstepDesktop?.digitalPerson?.onOpenChat(()=>{
  if(!workspace || !profile)return
  useProjectStore.getState().setActiveProject(workspace)
  navigate('/companion')
 }),[workspace,profile,navigate])
 return error?<p role="alert" className="digital-person-error">{error}</p>:null
}
