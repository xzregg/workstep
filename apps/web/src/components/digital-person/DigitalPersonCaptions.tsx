import {useEffect,useLayoutEffect,useRef} from 'react'
import type {AssistantChatMessage} from '../../stores/assistantStore'
import {useI18n} from '../../i18n'
import DigitalPersonFeedback from './DigitalPersonFeedback'
import MarkdownMessage from '../MarkdownMessage'

/** Presentation-only cleanup; the stored message and full conversation stay intact. */
function captionContent(content:string){
 return content
  .replace(/\[本轮附图的人脸识别观察（可能有误）\][\s\S]*?这些是画面中的人物，不代表谁正在发言；不改变消息作者或权限。/g,'')
  .replace(/!\[((?:\\.|[^\]\\])*)\]\(([^\n]*?)\)/g,(image,label:string,url:string)=>/(?:digital-person-camera|(?:^|[/])camera[-_.])/i.test(`${label}\n${url}`)?'':image)
  .trim()
}

/** Scrollable transcript with the same per-message feedback as the full history view. */
export default function DigitalPersonCaptions({messages,projectId,sessionId,greeting,liveText,feedback}:{projectId:string;messages:AssistantChatMessage[];sessionId:string;greeting:string;liveText:string;feedback?:Record<string,number>}){
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
 const captions=messages.filter(message=>message.role==='user'||message.role==='assistant').map(message=>({...message,content:captionContent(message.content)})).filter(message=>message.content||message.status==='running')
 return <div className="digital-home-caption-frame"><section ref={viewport} className="digital-home-subtitles" aria-label={t('digitalPerson.homeTranscript')} tabIndex={0} onLoadCapture={()=>{if(following.current&&viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight}} onScroll={event=>{
  const node=event.currentTarget
  following.current=node.scrollHeight-node.clientHeight-node.scrollTop<32
 }}>
  {captions.length?captions.map(message=><div key={message.id} className={message.role==='user'?'digital-home-user-caption':'digital-home-reply chat-message-row'}>
   {message.role==='user'&&<span className="digital-home-caption-label">{t('digitalPerson.homeYouSaid')}</span>}
   <MarkdownMessage content={message.content||(message.status==='running'?t('digitalPerson.homeStatethinking'):'')} projectId={projectId} streaming={message.status==='running'} plainText={message.role==='user'} reveal="off"/>
   {message.role==='assistant'&&message.status!=='running'&&message.content.trim()&&<div className="digital-home-reply-actions"><DigitalPersonFeedback messageId={message.id} initialValue={feedback?.[message.id]??0}/></div>}
  </div>):<p className="digital-home-reply">{greeting}</p>}
  {liveText&&<p className="digital-home-user-caption" aria-live="polite">{t('digitalPerson.homeYouSaid')}{liveText}</p>}
 </section></div>
}
