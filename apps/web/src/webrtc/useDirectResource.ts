import { useEffect, useState } from 'react'
import { isWebRtcRemoteBrowser } from './webrtcLocation'
import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import { browserActorHeaders } from '../utils/browserActor'
import { retryWebRtcTransfer } from './retryTransfer'
import { shouldProxyWebRtcHttp } from './transportAdapter'

export function useDirectResource(source: string): string | undefined {
  const direct=isWebRtcRemoteBrowser()&&Boolean(source)&&shouldProxyWebRtcHttp(source)
  const [loaded,setLoaded]=useState<{source:string;url:string}>()
  useEffect(()=>{
    if(!direct||!source)return
    const controller=new AbortController();let url:string|undefined
    void retryWebRtcTransfer(async()=>{
      const response=await gatewayFetch(source,{signal:controller.signal,headers:browserActorHeaders()})
      if(!response.ok)throw new Error(`HTTP ${response.status}`)
      return response.blob()
    },controller.signal).then(blob=>{
      if(controller.signal.aborted)return
      url=URL.createObjectURL(blob);setLoaded({source,url})
    }).catch(()=>undefined)
    return()=>{controller.abort();if(url)URL.revokeObjectURL(url)}
  },[source,direct])
  return direct?(loaded?.source===source?loaded.url:undefined):source
}
