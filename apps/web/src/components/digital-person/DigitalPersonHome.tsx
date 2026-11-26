import {setProactiveSpeechContext} from './digitalPersonProactive'
import {useCallback,useEffect,useEffectEvent,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react'
import {useNavigate} from 'react-router-dom'
import type {DigitalActivity,DigitalPersonProfile} from '../../api/digitalPerson'
import {identitySetupGreetingKey} from './identitySetupGreeting'
import type {AssistantChatMessage} from '../../stores/assistantStore'
import {useI18n} from '../../i18n'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import {VoiceprintNoticesContext} from '../../hooks/useVoiceInput'
import {useGatewayProjectPermissions} from '../../hooks/useGatewayProjectPermissions'
import {BrandIcon} from '../BrandIcon'
import Button from '../Button'
import DigitalPersonHomeComposer from './DigitalPersonHomeComposer'
import Icon from '../Icon'
import {resolveRobotAvatarState} from '../../utils/robotAvatarState'
import {callStates,orbPhaseFor} from './avatar/particlePalette'
import MemoryAtlas,{AtlasBackdrop} from './MemoryAtlas'
import DigitalPersonPresence from './DigitalPersonPresence'
import DigitalPersonHomeInsights from './DigitalPersonHomeInsights'
import DigitalPersonCalendar from './DigitalPersonCalendar'
import AvatarPresentation from '../AvatarPresentation'
import {selectRobotActivity} from './avatar/robotActivity'
import {useDigitalPersonAffect} from './useDigitalPersonAffect'
import DigitalPersonSpeech, {type DigitalPersonSpeechControls} from './DigitalPersonSpeech'
import DigitalPersonCamera, {type PrepareCameraMessage} from './DigitalPersonCamera'
import DigitalPersonVoiceDock from './DigitalPersonVoiceDock'
import FaceHomePanel from '../face-recognition/FaceHomePanel'
import {useDigitalPersonDialogue} from './useDigitalPersonDialogue'
import DigitalPersonWake, {type WakeControls} from './DigitalPersonWake'
import {useWakeEnabled} from './wakePreferences'
import {homePreferenceScope,readHomePreference,useHomePreference,writeHomePreference} from './homePreferences'
import {useAssistantPendingInserts} from '../../hooks/useAssistantPendingInserts'
import {DIGITAL_OUTPUT_FRAME,type DigitalOutputFrame} from './digitalPersonVoiceEvents'
import DigitalPersonCaptions from './DigitalPersonCaptions'
import DigitalPersonConversationFrame from './DigitalPersonConversationFrame'
import {DigitalPersonConversationDialog} from './DigitalPersonDelegationDialog'
import {useDigitalPersonUiActions} from './useDigitalPersonUiActions'
import {primeSpeechOutput,speechText} from '../../utils/speechOutput'
import {pendingInteractionItems} from '../../utils/interaction'
import {useFaceWelcome} from './useFaceWelcome'
import './DigitalPersonHome.css'

interface Props{
 profile:DigitalPersonProfile;activity:DigitalActivity|null;projectId:string;projectName:string;sessionId:string
 messages:AssistantChatMessage[];uiReply?:AssistantChatMessage;running:boolean;stopping?:boolean;active:boolean;error?:string;inputValue:string;children?:ReactNode
 composerDisabled?:boolean;onSendPending?:(text:string,ids:string[])=>Promise<boolean>;onSend:(text:string,prepared?:boolean,facePersonIds?:string[],recentFaces?:boolean)=>Promise<boolean>;onStop:()=>Promise<boolean>;onDraft:(text:string)=>void;onPrepareCamera?:(prepare:PrepareCameraMessage|null)=>void
}

function shouldSubmitPhoneTurn(content:string,reply?:AssistantChatMessage){
 const words=content.replace(/[\p{P}\s~～]/gu,'')
 if(!/^[嗯啊呃]+$/u.test(words))return true
 if(!/^嗯+$/u.test(words)||reply?.role!=='assistant'||reply.status!=='succeeded')return false
 const question=speechText(reply.content).trim()
 return /吗[？?]?$|(?:对|是|好|可以|行)吧[？?]$/u.test(question)
  ||/(?:^|[。！？!?\n])\s*(?:要不要|需不需要|能不能|可不可以|是不是|有没有|是否)[^。！？!?\n]*[？?]$/u.test(question)
}

/** Avatar-first presentation, using the same chat session, actions and composer. */
export default function DigitalPersonHome(props:Props){
 const {profile,activity,messages,projectId,projectName,sessionId,running,active}=props
 const {can}=useGatewayProjectPermissions(projectId)
 const canCompose=active&&!props.composerDisabled&&can('session.chat')
 const {t}=useI18n(),navigate=useNavigate(),compact=useCompactLayout()
 const [outputFrame,setOutput]=useState<DigitalOutputFrame>({projectId,sessionId,playing:false,level:0,busy:false}),[keyboardShown,setKeyboardShown]=useState(false),[chatShown,setChatShown]=useState(false)
 const output=active&&outputFrame.projectId===projectId&&outputFrame.sessionId===sessionId?outputFrame:{playing:false,level:0,busy:false,readingId:undefined,source:undefined,text:undefined}
 const speech=useRef<DigitalPersonSpeechControls>(null)
 const toggleCaptionSpeech=useCallback((id:string)=>speech.current?.toggle(id),[])
 const wake=useRef<WakeControls>(null)
 const draft=useRef(props.inputValue);draft.current=props.inputValue
 const updateDraft=(text:string)=>{draft.current=text;props.onDraft(text)}
 const preferenceScope=homePreferenceScope(projectId)
 const atlas=useHomePreference(preferenceScope,'atlas')
 const atlasMode=useRef(atlas);atlasMode.current=atlas
 const playbackSample=useRef(outputFrame)
 const readPlaybackLevel=useCallback(()=>playbackSample.current.playing?playbackSample.current.level:0,[])
 const speakerMuted=useHomePreference(preferenceScope,'speakerMuted')
 const savedMicrophone=useMemo(()=>readHomePreference(preferenceScope,'microphone'),[preferenceScope])
 const microphoneRestored=useRef<string|null>(null)
 const [facesShown,setFacesShown]=useState(false)
 const avatarAnchor=useRef<HTMLElement>(null)
 const [atlasPreviewTarget,setAtlasPreviewTarget]=useState<HTMLDivElement|null>(null)
 const ui=useDigitalPersonUiActions(active,sessionId,props.uiReply)
 const [delegationShown,setDelegationShown]=useState(false)
 const conversationWindow=ui.panel
 const transcriptVisible=chatShown&&!conversationWindow
 const presentationPaused=compact&&(Boolean(conversationWindow)||delegationShown||transcriptVisible||keyboardShown)
 if(!active){
  if(chatShown)setChatShown(false)
  if(facesShown)setFacesShown(false)
  if(keyboardShown)setKeyboardShown(false)
 }
 const [textSent,setTextSent]=useState(false)
 const outputBusy=output.playing||output.busy===true
 const blockNewSpeech=transcriptVisible||facesShown
 const speechMuted=speakerMuted
 useEffect(()=>{
  setProactiveSpeechContext({projectId,sessionId,profile:{...profile,auto_speak:true},muted:speechMuted,blockNew:!active||blockNewSpeech})
 },[active,projectId,sessionId,profile,speechMuted,blockNewSpeech])
 useEffect(()=>{
  return()=>setProactiveSpeechContext(null)
 },[])
 const textButton=useRef<HTMLButtonElement>(null),inputRef=useRef<HTMLTextAreaElement>(null)
 const recognized=useRef<(text:string)=>void>(()=>{})
 const submitVoiceDraft=useRef<(text:string)=>Promise<boolean>>(async()=>false)
 const dialogue=useDigitalPersonDialogue({projectId,sessionId,active:canCompose,running,speaking:outputBusy,playbackText:output.text,showLevel:!atlas,
  onRecognized:text=>recognized.current(text),onSendDraft:text=>submitVoiceDraft.current(text),onStop:props.onStop})
 useEffect(()=>{
  let published:DigitalOutputFrame={projectId,sessionId,playing:false,level:0,busy:false}
  playbackSample.current=published
  setOutput(published)
  const sources=new Map<string,DigitalOutputFrame>()
  const frame=(event:Event)=>{
   const value=(event as CustomEvent<DigitalOutputFrame>).detail
   if(value.projectId!==projectId||value.sessionId!==sessionId)return
   const key=value.source??'reply'
   if(value.playing||value.busy)sources.set(key,value)
   else sources.delete(key)
   const frames=Array.from(sources.values())
   const audible=frames.filter(item=>item.playing).sort((a,b)=>b.level-a.level)
   const next={...(audible[0]??frames[0]??value),busy:frames.length>0}
   playbackSample.current=next
   // Atlas amplitude is read by its visual meter. Publishing every 50 ms would
   // rerender the transcript, camera and composer even while the user types.
   if(next.playing===published.playing&&next.busy===published.busy&&next.readingId===published.readingId
     &&next.source===published.source&&next.metered===published.metered&&next.text===published.text
     &&(atlasMode.current||next.level===published.level))return
   published=next
   setOutput(next)
  }
  window.addEventListener(DIGITAL_OUTPUT_FRAME,frame)
  return()=>window.removeEventListener(DIGITAL_OUTPUT_FRAME,frame)
 },[projectId,sessionId])
 // Let the shared composer receive the cleared draft before its unmount saves it.
 // eslint-disable-next-line react/set-state-in-effect -- Commit the accepted draft before closing, within the same paint.
 useLayoutEffect(()=>{if(textSent){inputRef.current?.blur();setKeyboardShown(false);setTextSent(false)}},[textSent])
 useEffect(()=>{
  if(!active||!transcriptVisible)return
  const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){setChatShown(false);textButton.current?.focus()}}
  window.addEventListener('keydown',close)
  return()=>window.removeEventListener('keydown',close)
 },[active,transcriptVisible])
 const mute=dialogue.mute
 const lastMessage=messages.at(-1)
 const revealedInteraction=useRef('')
 const pendingInteraction=running&&lastMessage?.role==='assistant'
  ?pendingInteractionItems(lastMessage.events??[]).at(-1)?.request.interaction_id:''
 useEffect(()=>{
  if(!active||!pendingInteraction)return
  const key=`${sessionId}:${pendingInteraction}`
  if(revealedInteraction.current===key)return
  revealedInteraction.current=key
  mute();setKeyboardShown(false);setChatShown(true)
 },[active,sessionId,pendingInteraction,mute])
 const affect=useDigitalPersonAffect(projectId,sessionId,`${lastMessage?.id??''}:${lastMessage?.status??''}`)
 const hasVoiceDraft=!dialogue.continuous&&dialogue.draft!==null
 const micEnabled=dialogue.connected&&!dialogue.muted
 const microphoneOn=micEnabled&&!dialogue.playbackPaused
 const [wakeListening,setWakeListening]=useState(false)
 const [wakeGreeting,setWakeGreeting]=useState(false)
 const restoringMicrophone=savedMicrophone&&microphoneRestored.current!==preferenceScope
 const restoreMicrophone=useEffectEvent(()=>{
  if(document.hidden||microphoneRestored.current===preferenceScope||wake.current?.releaseMicrophone()===false)return
  microphoneRestored.current=preferenceScope
  if(!dialogue.connected)dialogue.toggle()
 })
 useEffect(()=>{
  if(!restoringMicrophone||!canCompose||running||outputBusy||wakeGreeting||facesShown||keyboardShown||transcriptVisible)return
  const restore=()=>restoreMicrophone()
  const timer=setTimeout(restore,0)
  document.addEventListener('visibilitychange',restore)
  return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',restore)}
 },[restoringMicrophone,preferenceScope,canCompose,running,outputBusy,wakeGreeting,facesShown,keyboardShown,transcriptVisible])
 const voicePhase=dialogue.phase
 const voiceActive=['requesting','preparing','recording','finishing'].includes(voicePhase)
 const welcome=useFaceWelcome({projectId,sessionId,active:canCompose&&profile.enabled,muted:speakerMuted,privateSpeechFallback:t('faceWelcome.defaultPhrase'),
  speechBusy:outputBusy||wakeGreeting,
  blocked:running||keyboardShown||transcriptVisible||facesShown||
   Boolean(conversationWindow)||Boolean(props.inputValue.trim())||dialogue.connected||dialogue.continuous||
   dialogue.sending||dialogue.draft!=null||voiceActive})
 const wakeEnabled=useWakeEnabled()
 const wakeBlocked=restoringMicrophone||running||facesShown||transcriptVisible||keyboardShown||dialogue.draft!==null||micEnabled||dialogue.continuous
 const state=output.playing?'speaking':running||outputBusy?'thinking':microphoneOn?'listening':activity?.checking?'checking':'idle'
 const wakeReady=canCompose&&wakeEnabled&&!wakeBlocked&&wakeListening&&(state==='idle'||state==='checking')
 const identityState=canCompose&&wakeGreeting?'speaking':wakeReady?'waitingForWake':state
 const motionActivity=useMemo(()=>selectRobotActivity(messages,running),[messages,running])
 const avatarPhase=state==='speaking'?'speaking':motionActivity?.kind==='work'?'working':motionActivity?.kind==='reply'?'replying':state==='checking'?'thinking':state
 const messageState=useMemo(()=>lastMessage?.role==='assistant'?resolveRobotAvatarState({
  streaming:lastMessage.status==='running',content:lastMessage.content,events:lastMessage.events,
  status:lastMessage.status==='error'?'failed':lastMessage.status==='stopped'?'stopped':undefined,
 }):undefined,[lastMessage])
 const orbPhase=orbPhaseFor({phase:avatarPhase,waitingForWake:wakeReady,
  preparingWake:canCompose&&wakeEnabled&&!wakeBlocked&&!wakeListening,message:messageState,playing:output.playing,outputBusy,
  sending:dialogue.sending,voicePhase:dialogue.phase,error:Boolean(dialogue.error||props.error),
  microphoneOn,muted:dialogue.connected&&dialogue.muted,checking:state==='checking'})
 const openText=()=>{textButton.current?.focus();setKeyboardShown(true)}
 const sendText=async(content?:string,ids?:string[],recentFaces?:boolean)=>{
  primeSpeechOutput()
  if(!await props.onSend(content??props.inputValue,content!==undefined,ids,recentFaces))return false
  setTextSent(true)
  return true
 }
 // Phone turns and explicitly sent microphone drafts share the pending queue.
 const pending=useAssistantPendingInserts({projectId,sessionId,messages,input:props.inputValue,onInputChange:updateDraft,
  onSendContent:(content,ids)=>{primeSpeechOutput();return props.onSendPending?.(content,ids)??Promise.resolve(false)},disabled:!canCompose})
 const keepInDraft=(text:string)=>updateDraft(draft.current.trim()?`${draft.current.trimEnd()}\n${text}`:text)
 submitVoiceDraft.current=content=>{
  primeSpeechOutput()
  return running ? pending.queueContent(content) : props.onSend(content)
 }
 const voiceSending=useRef(false),voiceBuffer=useRef<string[]>([])
 recognized.current=text=>{
  const content=text.trim()
  const finishedReply=!running&&!voiceSending.current?lastMessage:undefined
  if(!content||!shouldSubmitPhoneTurn(content,finishedReply))return
  if(running&&pending.queueEnabled){void pending.queueContent(content);return}
  if(running||voiceSending.current){voiceBuffer.current.push(content);return}
  voiceSending.current=true
  primeSpeechOutput()
  void props.onSend(content).then(accepted=>{
   voiceSending.current=false
   if(!accepted){keepInDraft(content);voiceBuffer.current.splice(0).forEach(keepInDraft)}
  },()=>{voiceSending.current=false;keepInDraft(content);voiceBuffer.current.splice(0).forEach(keepInDraft)})
 }
 // Segments spoken before the turn was accepted wait here and join the same
 // pending-insert queue the backend consumes when the reply completes.
 useEffect(()=>{
  if(!running||!pending.queueEnabled||!voiceBuffer.current.length)return
  voiceBuffer.current.splice(0).forEach(content=>void pending.queueContent(content))
 },[running,pending.queueEnabled,pending.queueContent])
 const returnWorkbench=()=>navigate(`/chat?project=${encodeURIComponent(projectName)}&session=${encodeURIComponent(sessionId)}`)
 const liveText=voiceActive?dialogue.text:''
 const voiceCaption=hasVoiceDraft?[dialogue.draft,liveText].filter(Boolean).join(' '):liveText
 const microphonePending=voicePhase==='requesting'||voicePhase==='preparing'||voicePhase==='finishing'?voicePhase:undefined
 const voiceAction=running?'stop':hasVoiceDraft?'send':dialogue.continuous?'hangup':'phone'
 const toggleCall=()=>{
  if(dialogue.continuous)dialogue.end()
  else if(wake.current?.releaseMicrophone()!==false){
   microphoneRestored.current=preferenceScope
   dialogue.startContinuous()
  }
 }
 const toggleMicrophone=()=>{
  if(wake.current?.releaseMicrophone()===false)return
  microphoneRestored.current=preferenceScope
  if(!dialogue.continuous)writeHomePreference(preferenceScope,'microphone',!microphoneOn)
  dialogue.toggle()
 }
 const microphoneAction=t(dialogue.continuous
  ?(microphoneOn?'digitalPerson.homeMute':'digitalPerson.homeUnmuteVoice')
  :(microphoneOn?'digitalPerson.homeCancelVoiceInput':'digitalPerson.homeStartVoiceInput'))
 const transcriptButton=<Button variant="ghost" className={`digital-home-dock-transcript${compact?' digital-home-settings':''}`} aria-label={t('digitalPerson.homeExpandConversation')} title={t('digitalPerson.homeExpandConversation')} aria-expanded={transcriptVisible} onClick={()=>{mute();setChatShown(true)}}><Icon name="message-circle-heart" size={16}/>{!compact&&<span>{t('digitalPerson.homeExpandConversation')}</span>}</Button>
 const atlasToggle=<Button variant="ghost" className="digital-home-atlas-toggle" onClick={()=>writeHomePreference(preferenceScope,'atlas',!atlas)}><span>{t(atlas?'digitalPerson.title':'digitalMemoryView.atlas')}</span></Button>
 return <VoiceprintNoticesContext value={false}><main className={`digital-home${atlas?' digital-home--atlas':''}${transcriptVisible||delegationShown?' digital-home--chat':''}${ui.panel?' digital-home--conversation-window':''}`} data-state={state}>
  {atlas&&active&&!compact&&<AtlasBackdrop/>}
  <header className="digital-home-header">
   <div className="digital-home-brand"><BrandIcon size={26}/><strong>WorkStep</strong><span>{t('digitalPerson.homeWorkspace')}</span></div>
   {!transcriptVisible&&transcriptButton}
   <Button variant="ghost" className="digital-home-settings digital-home-face-entry" disabled={!active} aria-label={t('faceRecognition.title')} title={t('faceRecognition.title')} aria-expanded={facesShown} aria-haspopup="dialog" onClick={()=>{mute();setFacesShown(true)}}><Icon name="scan-face" size={16}/></Button>
   <Button variant="ghost" className="digital-home-settings" aria-label={t('digitalPerson.title')} onClick={()=>{mute();window.dispatchEvent(new window.Event('workstep:open-digital-person-settings'))}}><Icon name="settings" size={16}/></Button>
   <Button variant="ghost" className="digital-home-back" aria-label={t('digitalPerson.homeBack')} onClick={returnWorkbench}><Icon name="chevron-right" size={16}/><span>{t('digitalPerson.homeBack')}</span></Button>
  </header>
  {canCompose&&<DigitalPersonWake ref={wake} projectId={projectId} playback={outputBusy} speakerMuted={speakerMuted} voice={profile}
    blocked={wakeBlocked}
    onWake={dialogue.startWakeContinuous} onListeningChange={setWakeListening} onGreetingChange={setWakeGreeting}/>}
  <div className="digital-home-main">
   <section ref={avatarAnchor} className="digital-home-stage" aria-label={profile.name}>
    {atlas?(active&&<MemoryAtlas key={projectId+'/'+sessionId} projectId={projectId} sessionId={sessionId} voiceLevel={output.playing?.35:0} readVoiceLevel={readPlaybackLevel} previewTarget={atlasPreviewTarget} paused={presentationPaused}/>):<AvatarPresentation projectId={projectId} sessionId={sessionId} name={profile.name} active={active} paused={presentationPaused}
      phase={avatarPhase} callState={callStates[orbPhase]} inputLevel={microphoneOn?dialogue.level:0} metered={outputFrame.metered!==false} activityId={motionActivity?.key} speaking={output.playing} level={output.level}
      affinity={affect.state?.affinity} emotion={affect.state?.emotion} intensity={Math.max(Math.abs(affect.state?.valence??0),affect.state?.arousal??0)/100}
      fallback={presentation=><DigitalPersonPresence key={`${projectId}/${sessionId}`} active={active} paused={presentationPaused} presentation={presentation} phase={orbPhase} readSpeechLevel={microphoneOn?dialogue.readSpeechLevel:undefined} metered={outputFrame.metered!==false} reply={lastMessage?.role==='assistant'?lastMessage:undefined} name={profile.name}/>}/>}
   </section>
   {welcome.text&&<p className="digital-home-welcome" role="status">{welcome.text}</p>}
   <DigitalPersonHomeInsights onConversationChange={setDelegationShown} atlasAction={atlasToggle} active={active} canControlWake={canCompose} name={profile.name} role={profile.role} state={identityState} activity={activity} affect={affect.state} chatShown={transcriptVisible} onInspect={mute}/>
   <DigitalPersonCalendar active={active&&!transcriptVisible&&!delegationShown&&!conversationWindow} projectId={projectId} canEdit={canCompose}/>
   {!transcriptVisible&&!conversationWindow&&!delegationShown&&<DigitalPersonCaptions projectId={projectId} messages={messages} feedback={activity?.feedback} sessionId={sessionId} greeting={identitySetupGreetingKey(profile)?t(identitySetupGreetingKey(profile)!):profile.greeting} liveText={voiceCaption} voicePhase={!hasVoiceDraft&&voiceActive?voicePhase:undefined}
    voiceDraft={hasVoiceDraft?dialogue.draft:undefined}
    onStartVoiceEdit={()=>{mute();dialogue.editDraft(voiceCaption)}}
    onChangeVoiceDraft={canCompose&&hasVoiceDraft&&!dialogue.sending?dialogue.editDraft:undefined}
    onClearVoice={canCompose&&!dialogue.continuous&&!dialogue.sending?dialogue.clearDraft:undefined}
    frameRef={atlas?setAtlasPreviewTarget:undefined}
    readingId={output.readingId} onToggleSpeech={toggleCaptionSpeech}/>}
   {transcriptVisible&&<DigitalPersonConversationFrame className="digital-home-chat" role="dialog" aria-label={t('digitalPerson.homeTranscript')} title={t('digitalPerson.homeTranscript')} onClose={()=>setChatShown(false)}>{props.children}</DigitalPersonConversationFrame>}
   {conversationWindow&&<DigitalPersonConversationDialog key={conversationWindow.id} projectId={conversationWindow.projectId}
    initialSessionId={conversationWindow.sessionId} initialHistory={conversationWindow.initialHistory} title={conversationWindow.title} onClose={ui.close}
    floating={{anchor:avatarAnchor,closing:conversationWindow.closing,onExited:()=>ui.finishClosing(conversationWindow.id)}}/>}
  </div>
  {(props.error||dialogue.error)&&<p className="digital-home-error" role="alert">{props.error||t(dialogue.error as never)}</p>}
  {dialogue.notice&&<p className="voice-input-notice" role="status">{t(dialogue.notice as never)}</p>}
  {ui.issue&&<p className="digital-home-error" role="status">{t(`digitalPersonUi.${ui.issue}`)}</p>}
  <footer className="digital-home-footer">
   <DigitalPersonCamera key={`${projectId}/${sessionId}`} compact projectId={projectId} preferenceScope={preferenceScope} active={active&&!facesShown} onWelcomeFrame={welcome.observe} onOpen={primeSpeechOutput} onManualOpen={welcome.cameraOpened} onManualClose={welcome.cameraClosed} onPrepare={props.onPrepareCamera} presentation={compact?'window':'panel'}>{!transcriptVisible&&!delegationShown&&<DigitalPersonHomeComposer shown={canCompose&&keyboardShown} onClose={()=>setKeyboardShown(false)} anchorRef={textButton} inputRef={inputRef} value={props.inputValue} onChange={updateDraft} onSend={sendText} onSendPending={(content,ids)=>{primeSpeechOutput();return props.onSendPending?.(content,ids)??Promise.resolve(false)}} pendingPanel={pending.panel} pendingError={pending.error} queueEnabled={pending.queueEnabled} queueCurrentInput={pending.queueCurrentInput} projectId={projectId} sessionId={sessionId} messages={messages} running={running} voiceDisabled={dialogue.connected} active={canCompose} onStop={()=>{void props.onStop()}}/>}
   {!transcriptVisible&&!delegationShown&&<DigitalPersonVoiceDock canCompose={canCompose} speakerMuted={speakerMuted} onToggleSound={()=>writeHomePreference(preferenceScope,'speakerMuted',!speakerMuted)}
    microphoneOn={microphoneOn&&voicePhase!=='requesting'} microphoneAction={microphoneAction}
    readSpeechLevel={microphoneOn&&(dialogue.phase==='recording'||dialogue.phase==='preparing')?dialogue.readSpeechLevel:undefined}
    microphoneDisabled={!canCompose||(!dialogue.continuous&&!micEnabled&&(dialogue.sending||running))} microphonePending={microphonePending}
    onMicrophone={toggleMicrophone} onHoldMicrophone={()=>{if(!dialogue.sending&&!running)toggleCall()}}
    action={voiceAction} actionDisabled={voiceAction==='send'&&!dialogue.draft?.trim()} sending={dialogue.sending} stopping={props.stopping}
    onAction={voiceAction==='stop'?dialogue.stopReply:voiceAction==='send'?dialogue.sendDraft:toggleCall}
    keyboardControl={<Button variant="ghost" ref={textButton} className="digital-home-keyboard" disabled={!canCompose} onClick={openText} aria-label={t('digitalPerson.homeKeyboard')} aria-haspopup="dialog" aria-expanded={canCompose&&keyboardShown}><Icon name="keyboard" size={24}/></Button>}/>}
   </DigitalPersonCamera>
   <DigitalPersonSpeech ref={speech} muted={speechMuted} blockNew={blockNewSpeech} manualEnabled={!blockNewSpeech} hideControls profile={{...profile,auto_speak:true}} projectId={projectId} sessionId={sessionId} messages={messages} active={active}/>
  </footer>
  {facesShown&&active&&<FaceHomePanel key={`${projectId}/${sessionId}`} onClose={()=>setFacesShown(false)}/>}
 </main></VoiceprintNoticesContext>
}
