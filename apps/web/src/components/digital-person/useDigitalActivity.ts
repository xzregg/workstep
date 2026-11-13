import { useEffect, useState } from 'react'
import { digitalRuntimeApi, type DigitalActivity } from '../../api/digitalPerson'
export const DIGITAL_ACTIVITY_CHANGED='workstep:digital-person-activity-changed'
export function useDigitalActivity(enabled:boolean) {
  const [data,setData]=useState<DigitalActivity|null>(null)
  useEffect(()=>{
    if(!enabled){setData(null);return}
    let active=true,pending=false
    const load=async()=>{if(pending)return;pending=true;try{const result=await digitalRuntimeApi.activity();if(active)setData(result)}catch{ /* Settings activity view exposes diagnostics. */ }finally{pending=false}}
    void load();window.addEventListener(DIGITAL_ACTIVITY_CHANGED,load)
    const timer=window.setInterval(load,30000)
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener(DIGITAL_ACTIVITY_CHANGED,load)}
  },[enabled])
  return data
}
