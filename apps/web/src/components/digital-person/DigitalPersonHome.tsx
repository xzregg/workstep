import {setProactiveSpeechContext} from './digitalPersonProactive'
import {useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react'
import {useNavigate} from 'react-router-dom'
import type {DigitalActivity,DigitalPersonProfile} from '../../api/digitalPerson'
import type {AssistantChatMessage} from '../../stores/assistantStore'
import {useProjectStore} from '../../stores/projectStore'
import {useI18n} from '../../i18n'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import {BrandIcon} from '../BrandIcon'
import Button from '../Button'
import ChatInput from '../ChatInput'
import Icon from '../Icon'
import DigitalPersonPresence from './DigitalPersonPresence'
import DigitalPersonHomeInsights from './DigitalPersonHomeInsights'
import AvatarPresentation from '../AvatarPresentation'
import {selectRobotActivity} from './avatar/robotActivity'
import {useDigitalPersonAffect} from './useDigitalPersonAffect'
import DigitalPersonSpeech from './DigitalPersonSpeech'
import DigitalPersonCamera, {DigitalPersonCameraToggle, type PrepareCameraMessage} from './DigitalPersonCamera'
import FaceHomePanel from '../face-recognition/FaceHomePanel'
import {useDigitalPersonDialogue} from './useDigitalPersonDialogue'
import {DIGITAL_OUTPUT_FRAME,type DigitalOutputFrame} from './digitalPersonVoiceEvents'
import DigitalPersonCaptions from './DigitalPersonCaptions'
import {primeSpeechOutput} from '../../utils/speechOutput'
import './DigitalPersonHome.css'

interface Props{
 profile:DigitalPersonProfile;activity:DigitalActivity|null;projectId:string;projectName:string;sessionId:string
 messages:AssistantChatMessage[];running:boolean;active:boolean;error?:string;inputValue:string;children?:ReactNode
 onSend:(text:string,prepared?:boolean,facePersonIds?:string[])=>Promise<boolean>;onStop:()=>Promise<boolean>;onDraft:(text:string)=>void;onPrepareCamera?:(prepare:PrepareCameraMessage|null)=>void
}
/** Avatar-first presentation, using the same chat session, actions and composer. */
export default function DigitalPersonHome(props:Props){
 const {profile,activity,messages,projectId,projectName,sessionId,running,active}=props
 const {t}=useI18n(),navigate=useNavigate(),compact=useCompactLayout()
 const [outputFrame,setOutput]=useState({projectId,sessionId,playing:false,level:0,busy:false}),[keyboardShown,setKeyboardShown]=useState(false),[chatShown,setChatShown]=useState(false)
 const output=active&&outputFrame.projectId===projectId&&outputFrame.sessionId===sessionId?outputFrame:{playing:false,level:0,busy:false}
 const [speakerMuted,setSpeakerMuted]=useState(false)
 const [facesShown,setFacesShown]=useState(false)
 useEffect(()=>{
  if(!active)return
  setProactiveSpeechContext({projectId,sessionId,profile:{...profile,auto_speak:true},muted:speakerMuted||chatShown||facesShown})
  return()=>setProactiveSpeechContext(null)
 },[active,projectId,sessionId,profile,speakerMuted,chatShown,facesShown])
 const [selectedMessage,setSelectedMessage]=useState('')
 const home=useRef<HTMLElement>(null)
 useEffect(()=>{if(!chatShown||!selectedMessage)return;const timer=window.setTimeout(()=>{const node=[...home.current?.querySelectorAll<HTMLElement>('[data-message-id]')??[]].find(el=>el.dataset.messageId===selectedMessage);node?.scrollIntoView({block:'center',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});node?.focus({preventScroll:true})},650);return()=>window.clearTimeout(timer)},[chatShown,selectedMessage,sessionId])
 const textButton=useRef<HTMLButtonElement>(null),inputRef=useRef<HTMLTextAreaElement>(null)
 const dialogue=useDigitalPersonDialogue({projectId,sessionId,active,running,speaking:output.playing||output.busy,onSend:props.onSend,onStop:props.onStop})
 useEffect(()=>{
  setOutput({projectId,sessionId,playing:false,level:0,busy:false})
  if(!active)return
  const frame=(event:Event)=>{
   const value=(event as CustomEvent<DigitalOutputFrame>).detail
   if(value.projectId===projectId&&value.sessionId===sessionId)setOutput({projectId,sessionId,playing:value.playing,level:value.level,busy:value.busy??value.playing})
  }
  window.addEventListener(DIGITAL_OUTPUT_FRAME,frame)
  return()=>window.removeEventListener(DIGITAL_OUTPUT_FRAME,frame)
 },[projectId,sessionId,active])
 useLayoutEffect(()=>{if(keyboardShown&&!chatShown)inputRef.current?.focus()},[keyboardShown,chatShown])
 useEffect(()=>{
  if(!keyboardShown&&!chatShown)return
  const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){setChatShown(false);setKeyboardShown(false);textButton.current?.focus()}}
  window.addEventListener('keydown',close)
  return()=>window.removeEventListener('keydown',close)
 },[keyboardShown,chatShown])
 const lastMessage=messages.at(-1)
 const affect=useDigitalPersonAffect(projectId,sessionId,`${lastMessage?.id??''}:${lastMessage?.status??''}`)
 const ready=dialogue.connected&&!dialogue.muted
 const state=output.playing?'speaking':running||dialogue.sending||output.busy?'thinking':ready?'listening':activity?.checking?'checking':'idle'
 const motionActivity=useMemo(()=>selectRobotActivity(messages,running),[messages,running])
 const avatarPhase=state==='speaking'?'speaking':motionActivity?.kind==='work'?'working':motionActivity?.kind==='reply'?'replying':state==='checking'?'thinking':state
 const task=activity?.delegations.find(d=>['running','queued'].includes(d.status)) || activity?.delegations.at(-1)
 const openText=()=>{dialogue.mute();if(dialogue.draft)props.onDraft(dialogue.draft);setKeyboardShown(value=>!value)}
 const returnWorkbench=()=>navigate(`/chat?project=${encodeURIComponent(projectName)}&session=${encodeURIComponent(sessionId)}`)
 const openWork=()=>{
  if(!task)return
  const project=useProjectStore.getState().projects.find(p=>p.id===task.project_id)
  if(!project)return
  useProjectStore.getState().setActiveProject(project)
  navigate(`/chat?project=${encodeURIComponent(project.name)}&session=${encodeURIComponent(task.session_id)}`)
 }
 const busy=['requesting','preparing','finishing'].includes(dialogue.phase)
 return <main ref={home} className={`digital-home${chatShown?' digital-home--chat':''}`} data-state={state}>
  <header className="digital-home-header">
   <div className="digital-home-brand"><BrandIcon size={26}/><strong>WorkStep</strong><span>{t('digitalPerson.homeWorkspace')}</span></div>
   <Button variant="ghost" className="digital-home-settings digital-home-face-entry" disabled={!active} aria-label={t('faceRecognition.title')} title={t('faceRecognition.title')} aria-expanded={facesShown} aria-haspopup="dialog" onClick={()=>{dialogue.mute();setFacesShown(true)}}><Icon name="scan-face" size={16}/></Button>
   <Button variant="ghost" className="digital-home-settings" aria-label={t('digitalPerson.title')} onClick={()=>{dialogue.mute();window.dispatchEvent(new window.Event('workstep:open-digital-person-settings'))}}><Icon name="settings" size={16}/></Button>
   <Button variant="ghost" className="digital-home-back" onClick={returnWorkbench}><Icon name="chevron-right" size={16}/>{t('digitalPerson.homeBack')}</Button>
  </header>
  <div className="digital-home-main">
   <section className="digital-home-stage" aria-label={profile.name}>
    <AvatarPresentation projectId={projectId} sessionId={sessionId} name={profile.name} active={active}
      phase={avatarPhase} activityId={motionActivity?.key} speaking={output.playing} level={output.level}
      affinity={affect.state?.affinity} emotion={affect.state?.emotion} intensity={Math.max(Math.abs(affect.state?.valence??0),affect.state?.arousal??0)/100}
      fallback={presentation=><DigitalPersonPresence key={`${projectId}/${sessionId}`} active={active} presentation={presentation} inputLevel={ready?dialogue.level:0} name={profile.name}/>}/>
   </section>
   <DigitalPersonHomeInsights active={active} name={profile.name} role={profile.role} state={state} activity={activity} affect={affect.state} messages={messages} chatShown={chatShown} onInspect={()=>dialogue.mute()} onWork={openWork} onConversation={id=>{setSelectedMessage(id??'');dialogue.mute();setChatShown(true)}}/>
   {!chatShown&&<DigitalPersonCaptions projectId={projectId} messages={messages} feedback={activity?.feedback} sessionId={sessionId} greeting={profile.greeting} liveText={dialogue.text||dialogue.draft}/>}
   {chatShown&&<section className="digital-home-chat" aria-label={t('digitalPerson.homeTranscript')}><header><h2>{t('digitalPerson.homeTranscript')}</h2><Button variant="ghost" onClick={()=>setChatShown(false)} aria-label={t('common.close')}><Icon name="x" size={18}/></Button></header>{props.children}</section>}
  </div>
  {(props.error||dialogue.error)&&<p className="digital-home-error" role="alert">{props.error||t(dialogue.error as never)}</p>}
  <footer className="digital-home-footer">
   <DigitalPersonCamera key={`${projectId}/${sessionId}`} compact projectId={projectId} active={active&&!facesShown} onPrepare={props.onPrepareCamera} presentation={compact?'window':'panel'} panelContent={<section className="digital-home-camera-perception"><Button variant="ghost" onClick={()=>{dialogue.mute();setFacesShown(true)}}><Icon name="scan-face" size={16}/>{t('faceRecognition.title')}<Icon name="chevron-right" size={14}/></Button></section>}>{!chatShown&&keyboardShown&&<div className="digital-home-composer"><ChatInput inputRef={inputRef} value={props.inputValue} onChange={props.onDraft} onSend={(content,ids)=>{primeSpeechOutput();void props.onSend(content ?? props.inputValue, content !== undefined,ids)}} projectId={projectId} sessionId={sessionId} imageAttach={{projectId}} running={running} onStop={()=>{void props.onStop()}} disabled={!active}/></div>}
   {!chatShown&&<div className="digital-home-voice-dock">
    <Button variant="ghost" className="digital-home-speaker" onClick={()=>setSpeakerMuted(value=>!value)} aria-label={t(speakerMuted?'digitalPerson.homeEnableSound':'digitalPerson.homeMuteSound')} aria-pressed={!speakerMuted}><Icon name={speakerMuted?'volume-off':'volume'} size={24}/></Button>
    <Button variant="ghost" className="digital-home-microphone" aria-label={t(ready?'digitalPerson.homeMute':'digitalPerson.homeStartVoice')} aria-pressed={ready} loading={busy} onClick={dialogue.toggle} disabled={!active||dialogue.sending}><Icon name={ready?'mic':'mic-off'} size={24}/></Button>
    <Button variant="ghost" className="digital-home-dock-transcript" aria-expanded={chatShown} onClick={()=>{dialogue.mute();setSelectedMessage('');setChatShown(true)}}><Icon name="message-circle-heart" size={16}/>{t('digitalPerson.homeExpandConversation')}</Button>
    <DigitalPersonCameraToggle/>
    <Button variant="ghost" className="digital-home-end" aria-label={t('digitalPerson.homeEnd')} disabled={!dialogue.connected&&!running&&!output.playing&&!output.busy} onClick={dialogue.end}><Icon name="phone-off" size={24}/></Button>
   </div>}{!chatShown&&<div className="digital-home-input-actions"><Button variant="ghost" ref={textButton} className="digital-home-keyboard" onClick={openText} aria-label={t('digitalPerson.homeKeyboard')} aria-expanded={keyboardShown}><Icon name="keyboard" size={24}/></Button><Button variant="ghost" className="digital-home-transcript-button" onClick={()=>{dialogue.mute();setSelectedMessage('');setChatShown(true)}}>{t('digitalPerson.homeTranscript')}<Icon name="chevron-right" size={14}/></Button></div>}</DigitalPersonCamera>
   <DigitalPersonSpeech muted={speakerMuted||chatShown||facesShown} hideControls profile={{...profile,auto_speak:true}} projectId={projectId} sessionId={sessionId} messages={messages} active={active}/>
  </footer>
  {facesShown&&active&&<FaceHomePanel key={`${projectId}/${sessionId}`} onClose={()=>setFacesShown(false)}/>}
 </main>
}
