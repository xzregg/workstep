import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import type {AssistantChatMessage} from '../../stores/assistantStore'
import {useI18n} from '../../i18n'
import type {VoicePhase} from '../../hooks/useVoiceInput'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import Icon from '../Icon'
import Button from '../Button'
import Spinner from '../Spinner'
import DigitalPersonFeedback from './DigitalPersonFeedback'
import DigitalPersonProgress from './DigitalPersonProgress'
import {recordedCommentary} from './digitalPersonCommentary'
import MarkdownMessage from '../MarkdownMessage'
import {formatDuration,toMilliseconds} from '../../utils/datetime'
import {speechText} from '../../utils/speechOutput'
import {hasActiveSelectionWithin,isNearConversationBottom,shouldPauseConversationFollow} from '../../utils/conversationScroll'
import {disposeConversationFollow,followConversationBottom} from '../../utils/smoothConversationFollow'

/** Presentation-only cleanup; the stored message and full conversation stay intact. */
export function captionContent(content:string){
 return content
  .replace(/\[本轮附图的人脸识别观察（可能有误）\][\s\S]*?这些是画面中的人物，不代表谁正在发言；不改变消息作者或权限。/g,'')
  .replace(/!\[((?:\\.|[^\]\\])*)\]\(([^\n]*?)\)/g,(image,label:string,url:string)=>/(?:digital-person-camera|(?:^|[/])camera[-_.])/i.test(`${label}\n${url}`)?'':image)
  .trim()
}

function ThinkingCaption({createdAt}:{createdAt?:string}){
 const {t}=useI18n(),[now,setNow]=useState(Date.now)
 const start=toMilliseconds(createdAt)
 useEffect(()=>{
  if(start===null)return
  const timer=setInterval(()=>setNow(Date.now()),1000)
  return()=>clearInterval(timer)
 },[start])
 return <p className="digital-home-thinking">{t('digitalPerson.homeStatethinking')}{start!==null&&<> <span>{formatDuration(Math.max(0,now-start),t)}</span></>}</p>
}

const captionSegmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'})

function LiveCaptionText({text,compact,voicePhase,onEdit,editLabel}:{text:string;compact:boolean;voicePhase?:VoicePhase;onEdit?:()=>void;editLabel?:string}){
 const paragraph=useRef<HTMLParagraphElement>(null),editableText=useRef<HTMLSpanElement>(null)
 useLayoutEffect(()=>{
  const caption=compact&&editableText.current?editableText.current:paragraph.current
  if(!caption)return
  if(compact)caption.scrollTop=caption.scrollHeight
  else caption.scrollLeft=caption.scrollWidth
 },[text,compact,voicePhase])
 const [preview,setPreview]=useState({text,offset:0})
 let offset=preview.offset
 if(text!==preview.text){
  offset=0
  while(offset<text.length&&text[offset]===preview.text[offset])offset++
  offset=captionSegmenter.segment(text).containing(offset)?.index??offset
  setPreview({text,offset})
 }
 const content=<>{text.slice(0,offset)}{offset<text.length&&<span key={text} className="digital-home-live-caption-reveal">{text.slice(offset)}</span>}</>
 return <p ref={paragraph}>{onEdit&&text.trim()?<button type="button" className="digital-home-live-caption-edit" title={editLabel} aria-label={`${editLabel} ${text}`} onClick={onEdit}><span ref={editableText}>{content}</span></button>:content}</p>
}

function EditableVoiceCaption({text,value,compact,voicePhase,onStart,onChange}:{text:string;value:string;compact:boolean;voicePhase?:VoicePhase;onStart?:()=>void;onChange:(value:string)=>void}){
 const {t}=useI18n(),[editing,setEditing]=useState(false)
 const label=t('common.edit')
 return editing?<textarea className="digital-home-live-caption-editor" aria-label={label} autoFocus value={value}
  onChange={event=>onChange(event.currentTarget.value)}
  onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.stopPropagation();setEditing(false)}}}/>:
  <LiveCaptionText text={text} compact={compact} voicePhase={voicePhase} editLabel={label} onEdit={()=>{onStart?.();setEditing(true)}}/>
}

/** Scrollable transcript with feedback and explicit playback for completed replies. */
export default function DigitalPersonCaptions({messages,projectId,sessionId,greeting,liveText,voicePhase,feedback,readingId,onToggleSpeech,onClearVoice,voiceDraft,onStartVoiceEdit,onChangeVoiceDraft,frameRef}:{projectId:string;messages:AssistantChatMessage[];sessionId:string;greeting:string;liveText:string;voicePhase?:VoicePhase;feedback?:Record<string,number>;readingId?:string;onToggleSpeech?:(id:string)=>void;onClearVoice?:()=>void;voiceDraft?:string|null;onStartVoiceEdit?:()=>void;onChangeVoiceDraft?:(value:string)=>void;frameRef?:(frame:HTMLDivElement|null)=>void}){
 const {t}=useI18n(),viewport=useRef<HTMLElement>(null),following=useRef(true)
 const historyContent=useRef<HTMLDivElement>(null),programmaticTop=useRef(0),previousTop=useRef(0)
 const compact=useCompactLayout()
 const showClear=!!(onClearVoice&&(liveText||voiceDraft!=null))
 const followLatest=useCallback((immediate=false)=>{
  const node=viewport.current
  if(node&&!hasActiveSelectionWithin(node,node.ownerDocument.getSelection())){
   followConversationBottom(node,programmaticTop,following,immediate)
  }
 },[])
 useLayoutEffect(()=>{
  const node=viewport.current
  following.current=true
  followLatest(true)
  previousTop.current=programmaticTop.current
  return()=>disposeConversationFollow(node)
 },[projectId,sessionId,followLatest])
 useLayoutEffect(()=>followLatest(),[messages,followLatest])
 useEffect(()=>{
  const node=viewport.current,content=historyContent.current
  if(!node||!content||typeof ResizeObserver==='undefined')return
  const observer=new ResizeObserver(()=>followLatest())
  observer.observe(node)
  observer.observe(content)
  return()=>observer.disconnect()
 },[followLatest])
 const pauseFollowing=(node:HTMLElement)=>{
  if(node.scrollHeight>node.clientHeight)following.current=false
 }
 const history=useMemo(()=>{
  const captions=messages.filter(message=>message.role==='user'||message.role==='assistant').map(message=>({...message,content:captionContent(message.content)})).filter(message=>message.content||message.status==='running'||recordedCommentary(message).length)
  return captions.length?captions.map(message=><div key={message.id} className={message.role==='user'?'digital-home-user-caption':'digital-home-reply chat-message-row'}>
   {message.role==='user'&&<span className="digital-home-caption-label">{t('digitalPerson.homeYouSaid')}</span>}
   {message.role==='assistant'&&<DigitalPersonProgress message={message}/>}
   {!message.content&&message.role==='assistant'&&message.status==='running'?<ThinkingCaption key={sessionId} createdAt={message.created_at}/>:<MarkdownMessage content={message.content} projectId={projectId} streaming={message.status==='running'} plainText={message.role==='user'} reveal="off"/>}
   {message.role==='assistant'&&message.status!=='running'&&message.content.trim()&&<div className="digital-home-reply-actions">
    <DigitalPersonFeedback messageId={message.id} initialValue={feedback?.[message.id]??0}/>
    {onToggleSpeech&&speechText(message.content).trim()&&<Button variant="ghost" className="chat-message-action digital-person-feedback-button" aria-label={t(readingId===message.id?'tts.stop':'tts.play')} title={t(readingId===message.id?'tts.stop':'tts.play')} onClick={()=>onToggleSpeech(message.id)}><Icon name={readingId===message.id?'square':'volume'} size={14}/></Button>}
   </div>}
  </div>):<p className="digital-home-reply">{greeting}</p>
 },[messages,projectId,sessionId,greeting,feedback,readingId,onToggleSpeech,t])
 return <div className="digital-home-caption-frame" ref={frameRef}><section ref={viewport} className="digital-home-subtitles" aria-label={t('digitalPerson.homeTranscript')} tabIndex={0}
  onWheelCapture={event=>{if(shouldPauseConversationFollow({type:'wheel',deltaY:event.deltaY}))pauseFollowing(event.currentTarget)}}
  onKeyDownCapture={event=>{if(shouldPauseConversationFollow({type:'key',key:event.key}))pauseFollowing(event.currentTarget)}}
  onScroll={event=>{
   const {scrollHeight,scrollTop,clientHeight}=event.currentTarget
   const atBottom=isNearConversationBottom(scrollHeight,scrollTop,clientHeight,1)
   // A new message can grow the content before the programmatic scroll event arrives.
   if(atBottom&&scrollTop>previousTop.current)following.current=true
   else if(!atBottom&&Math.abs(scrollTop-programmaticTop.current)>1)following.current=false
   previousTop.current=scrollTop
  }}>
  <div ref={historyContent}>{history}</div>
 </section>
 <div className="digital-home-live-caption-slot">
  {(voicePhase||liveText||voiceDraft!=null)&&<div className="digital-home-live-caption" data-phase={voicePhase??'submitted'} role={onChangeVoiceDraft?undefined:'status'}>
   {!compact&&<div className="digital-home-live-caption-status">{voicePhase&&voicePhase!=='recording'?<Spinner size={14}/>:<Icon name="audio-lines" size={14}/>}<span>{voicePhase?t(`speech.${voicePhase}`):t('digitalPerson.homeYouSaid')}</span></div>}
   {voiceDraft!=null&&onChangeVoiceDraft?
    <EditableVoiceCaption key={sessionId} text={liveText} value={voiceDraft} compact={compact} voicePhase={voicePhase} onStart={onStartVoiceEdit} onChange={onChangeVoiceDraft}/>:
    (compact||liveText)&&<LiveCaptionText key={sessionId} text={liveText} compact={compact} voicePhase={voicePhase}/>}
  </div>}
  {showClear&&<Button variant="icon" className="digital-home-live-caption-clear" aria-label={t('digitalPerson.homeClearVoiceInput')} title={t('digitalPerson.homeClearVoiceInput')} onClick={onClearVoice}><Icon name="x"/></Button>}
 </div>
 </div>
}
