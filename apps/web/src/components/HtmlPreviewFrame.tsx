import { forwardRef, useEffect, useState, type IframeHTMLAttributes } from 'react'
import { isWebRtcRemoteBrowser } from '../webrtc/webrtcLocation'
import { DirectHtmlResources } from '../webrtc/directHtmlResources'

/** Keeps native HTTP frames locally; direct frames receive an isolated offline document. */
export const HtmlPreviewFrame=forwardRef<HTMLIFrameElement,IframeHTMLAttributes<HTMLIFrameElement>>(function HtmlPreviewFrame({src,srcDoc,...props},ref){
  const direct=isWebRtcRemoteBrowser()&&Boolean(src)
  const [result,setResult]=useState<{src:string;html:string}>()
  useEffect(()=>{
    if(!direct||!src)return
    const root=new URL('.',new URL(src,window.location.href)).href
    // The root is the ticket directory, independent of nested entry paths.
    const match=root.match(/^(.*\/api\/fs\/html-resource\/[^/]+\/[^/]+\/)/)
    if(!match)return
    const resources=new DirectHtmlResources(match[1]);let active=true
    void resources.document(new URL(src,window.location.href).href).then(html=>{if(active)setResult({src,html})}).catch(error=>{
      if(active){const document=new window.DOMParser().parseFromString('<p></p>','text/html');document.querySelector('p')!.textContent=String(error);setResult({src,html:document.documentElement.outerHTML})}
    })
    return()=>{active=false;resources.dispose()}
  },[direct,src])
  return <iframe {...props} ref={ref} src={direct?undefined:src} srcDoc={direct?(result&&result.src===src?result.html:'<!doctype html>'):srcDoc}/>
})
