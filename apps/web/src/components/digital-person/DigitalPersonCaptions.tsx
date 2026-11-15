import {useEffect,useLayoutEffect,useRef} from 'react'
import type {AssistantChatMessage} from '../../stores/assistantStore'
import {useI18n} from '../../i18n'
import MarkdownMessage from '../MarkdownMessage'

/** Scrollable subtitle transcript; full message tools remain in the history view. */
export default function DigitalPersonCaptions({messages,projectId,sessionId,greeting,liveText}:{projectId:string;messages:AssistantChatMessage[];sessionId:string;greeting:string;liveText:string}){
 const {t}=useI18n(),viewport=useRef<HTMLElement>(null),following=useRef(true)
 useLayoutEffect(()=>{following.current=true},[sessionId])
 useLayoutEffect(()=>{
  if(following.current&&viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight
 },[messages,liveText,sessionId])
 useEffect(()=>{
  const node=viewport.current
  if(!node||typeof ResizeObserver==='undefined')return
  const observer=new ResizeObserver(()=>{if(following.current)node.scrollTop=node.scrollHeight})
  observer.observe(node)
  return()=>observer.disconnect()
 },[])
 const captions=messages.filter(message=>message.role==='user'||message.role==='assistant')
 return <div className="digital-home-caption-frame"><section ref={viewport} className="digital-home-subtitles" aria-label={t('digitalPerson.homeTranscript')} tabIndex={0} onLoadCapture={()=>{if(following.current&&viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight}} onScroll={event=>{
  const node=event.currentTarget
  following.current=node.scrollHeight-node.clientHeight-node.scrollTop<32
 }}>
  {captions.length?captions.map(message=><div key={message.id} className={message.role==='user'?'digital-home-user-caption':'digital-home-reply'}>
   {message.role==='user'&&<span className="digital-home-caption-label">{t('digitalPerson.homeYouSaid')}</span>}
   <MarkdownMessage content={message.content||(message.status==='running'?t('digitalPerson.homeStatethinking'):'')} projectId={projectId} streaming={message.status==='running'} plainText={message.role==='user'} reveal="off"/>
  </div>):<p className="digital-home-reply">{greeting}</p>}
  {liveText&&<p className="digital-home-user-caption" aria-live="polite">{t('digitalPerson.homeYouSaid')}{liveText}</p>}
 </section></div>
}
