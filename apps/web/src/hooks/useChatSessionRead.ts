import { useEffect, useRef } from 'react'
import { chatSessionApi } from '../api/conversations'

const TERMINAL = new Set(['completed','succeeded','failed','error','stopped'])

export type ChatReadTarget = {messageId: string | null; onResultVisible?: (status: string) => void}

/** A fetched background conversation is not a read: acknowledge visible results only. */
export function useChatSessionRead(projectId: string, sessionId: string | null,
  messages: Array<{id:string;role:string;status?:string}>, active: boolean, ready: boolean, target?: ChatReadTarget) {
  const result=messages.findLast(m=>m.role==='assistant' && TERMINAL.has(m.status || '') && (!target || m.id===target.messageId))
  const messageId=result?.id, status=result?.status, onResultVisible=target?.onResultVisible
  const shown=useRef<string>(null)
  const acknowledged=useRef(new Set<string>())
  const pending=useRef(new Set<string>())
  useEffect(()=>{
    if(!active || !ready || !projectId || !sessionId || !messageId || !status)return
    const key=`${projectId}/${sessionId}/${messageId}`
    const report=()=>{
      if(document.visibilityState!=='visible' || !document.hasFocus())return
      if(onResultVisible && shown.current!==key){
        shown.current=key
        onResultVisible(status)
      }
      if(acknowledged.current.has(key) || pending.current.has(key))return
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
  },[projectId,sessionId,messageId,status,active,ready,onResultVisible])
}
