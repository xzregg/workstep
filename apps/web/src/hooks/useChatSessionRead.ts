import { useEffect, useRef } from 'react'
import { chatSessionApi } from '../api/conversations'

const TERMINAL = new Set(['completed','succeeded','failed','error','stopped'])

/** A fetched background conversation is not a read: acknowledge visible results only. */
export function useChatSessionRead(projectId: string, sessionId: string | null,
  messages: Array<{id:string;role:string;status?:string}>, active: boolean, ready: boolean) {
  const messageId=messages.findLast(m=>m.role==='assistant' && TERMINAL.has(m.status || ''))?.id
  const acknowledged=useRef(new Set<string>())
  const pending=useRef(new Set<string>())
  useEffect(()=>{
    if(!active || !ready || !projectId || !sessionId || !messageId)return
    const key=`${projectId}/${sessionId}/${messageId}`
    const report=()=>{
      if(document.visibilityState!=='visible' || !document.hasFocus() || acknowledged.current.has(key) || pending.current.has(key))return
      pending.current.add(key)
      void chatSessionApi.markRead(sessionId,projectId,messageId).then(()=>{
        acknowledged.current.add(key)
        if(acknowledged.current.size>200)acknowledged.current.delete(acknowledged.current.values().next().value!)
      }).catch(error=>console.warn('Chat read receipt failed:',error)).finally(()=>pending.current.delete(key))
    }
    report()
    document.addEventListener('visibilitychange',report)
    window.addEventListener('focus',report)
    window.addEventListener('workstep:reconnected',report)
    return()=>{
      document.removeEventListener('visibilitychange',report)
      window.removeEventListener('focus',report)
      window.removeEventListener('workstep:reconnected',report)
    }
  },[projectId,sessionId,messageId,active,ready])
}
