import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { DigitalPersonProfile } from '../../api/digitalPerson'
import { OUTPUT_CHANGED, type OutputSettings } from '../../api/speechOutput'
import { useI18n, localizeErrorDisplay } from '../../i18n'
import type { AssistantChatMessage } from '../../stores/assistantStore'
import { primeSpeechOutput, SpeechOutputPlayer, speechText, streamingSpeechLimit, takeSpeechSentences } from '../../utils/speechOutput'
import { loadSpeechOutputSettings, invalidateSpeechOutputSettings } from '../../utils/speechOutputSettings'
import {DIGITAL_OUTPUT_FRAME,STOP_DIGITAL_SPEECH,type DigitalOutputFrame} from './digitalPersonVoiceEvents'
import {captionContent} from './DigitalPersonCaptions'
import Button from '../Button'
import './DigitalPersonSpeech.css'

export interface DigitalPersonSpeechControls { toggle: (id: string) => void }

/** Owns playback only; reads the existing chat messages without another session/store. */
export default function DigitalPersonSpeech({ ref, profile, projectId, sessionId, messages, active, muted = false, blockNew = false, manualEnabled = true }: {
  profile: DigitalPersonProfile; projectId: string; sessionId: string | null
  messages: AssistantChatMessage[]; active: boolean; hideControls?: boolean; muted?: boolean
  ref?: Ref<DigitalPersonSpeechControls>; manualEnabled?: boolean; blockNew?: boolean
}) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<OutputSettings | null>(null)
  const [playing, setPlaying] = useState(false), [error, setError] = useState('')
  const [hasRemaining, setHasRemaining] = useState(false)
  const player = useRef<SpeechOutputPlayer | null>(null)
  const manual = useRef<{id:string} | null>(null)
  const recovery = useRef<{remaining: string[]; submitted: number; readingId?: string} | null>(null)
  const tracked = useRef({ id: '', consumed: 0, text: '', started: false, suppressed: false })
  const outputFrame=useRef({playing:false,level:0,busy:false,metered:false})
  const publishOutput=useCallback(()=>window.dispatchEvent(new window.CustomEvent<DigitalOutputFrame>(DIGITAL_OUTPUT_FRAME,{detail:{projectId,sessionId,...outputFrame.current,readingId:manual.current?.id}})),[projectId,sessionId])
  const latest = messages[messages.length - 1]
  const reply = latest?.role === 'assistant' ? latest : null
  const stop = useCallback((preserveRecovery = false) => {
    if (recovery.current) {
      if (preserveRecovery) recovery.current = { ...recovery.current }
      else { recovery.current = null; setHasRemaining(false); setError('') }
    }
    const current=player.current
    player.current=null; manual.current=null; current?.stop()
    if(outputFrame.current.busy||outputFrame.current.playing){
      outputFrame.current={playing:false,level:0,busy:false,metered:false};setPlaying(false);publishOutput()
    }
  }, [publishOutput])

  useEffect(() => {
    let alive = true
    const load = (event?: Event) => {
      if (event) invalidateSpeechOutputSettings(event)
      stop(!!event)
      if (!recovery.current) tracked.current.suppressed = true
      void loadSpeechOutputSettings(projectId).then(settings => { if (alive) { setSettings(settings); if (!recovery.current) setError('') } })
        .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)) })
    }
    load()
    window.addEventListener(OUTPUT_CHANGED, load)
    return () => { alive = false; stop(); window.removeEventListener(OUTPUT_CHANGED, load) }
  }, [projectId, stop])
  useEffect(() => {
    stop(); tracked.current = { id: '', consumed: 0, text: '', started: false, suppressed: false }
    return stop
  }, [stop])
  useEffect(() => {
    window.dispatchEvent(new window.CustomEvent('workstep:digital-person-speaking', { detail: playing }))
    return () => { window.dispatchEvent(new window.CustomEvent('workstep:digital-person-speaking', { detail: false })) }
  }, [playing])

  useEffect(()=>{
    const interrupt=(event:Event)=>{
      const detail=(event as CustomEvent).detail
      if(detail?.projectId!==projectId||detail?.sessionId!==sessionId)return
      tracked.current.suppressed=true;stop()
    }
    window.addEventListener(STOP_DIGITAL_SPEECH,interrupt)
    return()=>window.removeEventListener(STOP_DIGITAL_SPEECH,interrupt)
  },[projectId,sessionId,stop])

  const rememberFailure = (reason: unknown, remaining: string[], readingId?: string, submitted = 0) => {
    recovery.current = { remaining, submitted, readingId }
    setHasRemaining(remaining.length > 0)
    setError(reason instanceof Error ? reason.message : String(reason))
  }

  const makePlayer = (config:OutputSettings, readingId?: string) => {
    outputFrame.current.metered=config.mode!=='system'&&config.volume>0
    const result = new SpeechOutputPlayer({ projectId, coalesce: !!readingId, batchStreaming: !readingId, digitalSessionId: sessionId ?? undefined,
      settings: { ...config, rate: profile.voice_rate ?? config.rate }, systemVoice: profile.voice_name,
      onPlayback: value=>{if(player.current===result){outputFrame.current.playing=value;publishOutput()}},
      onLevel: value=>{if(player.current===result){outputFrame.current.level=value;publishOutput()}},
      onInterrupt: () => { if (player.current === result) { tracked.current.suppressed = true; stop() } },
      onState: value=>{if(player.current===result){if(!value)manual.current=null;setPlaying(value);outputFrame.current.busy=value;publishOutput()}},
      onRecovery: (reason, remaining, submitted) => { if (player.current === result) rememberFailure(reason, remaining, readingId, submitted) } })
    player.current = result
    return result
  }

  const retry = async () => {
    const pending = recovery.current
    if (!pending?.remaining.length || outputFrame.current.busy || !active || muted || blockNew || !manualEnabled) return
    primeSpeechOutput()
    outputFrame.current.busy = true; setPlaying(true); publishOutput()
    try {
      const config = await loadSpeechOutputSettings(projectId)
      if (recovery.current !== pending || !outputFrame.current.busy) return
      recovery.current = null; setHasRemaining(false); setError('')
      if (pending.readingId) manual.current = { id: pending.readingId }
      makePlayer(config, pending.readingId).enqueue(pending.remaining, { final: !!pending.readingId || reply?.status === 'succeeded', submitted: pending.submitted })
    } catch (reason) {
      if (recovery.current !== pending || !outputFrame.current.busy) return
      stop(true); rememberFailure(reason, pending.remaining, pending.readingId, pending.submitted)
    }
  }

  useImperativeHandle(ref,()=>({toggle:async(id)=>{
    if(!active||!manualEnabled)return
    if(manual.current?.id===id){stop();return}
    if (recovery.current && (recovery.current.readingId ?? tracked.current.id) === id && recovery.current.remaining.length) { void retry(); return }
    const message=messages.find(row=>row.id===id&&row.role==='assistant'&&row.status!=='running')
    if(!message)return
    const {sentences}=takeSpeechSentences(speechText(captionContent(message.content)),true,true)
    if(!sentences.length)return
    primeSpeechOutput()
    stop();tracked.current.suppressed=true;setError('')
    const request={id}
    manual.current=request;outputFrame.current.busy=true;publishOutput()
    try{
      const config=await loadSpeechOutputSettings(projectId)
      if(manual.current!==request)return
      const current=makePlayer(config,id)
      await current.unlock()
      if(manual.current===request)current.enqueue(sentences)
    }catch(reason){
      if(manual.current!==request)return
      stop();rememberFailure(reason,sentences,id)
    }
  }}))

  useEffect(() => {
    if (muted) {
      stop(); tracked.current = { id: reply?.id ?? '', consumed: 0, text: '', started: false, suppressed: true }; return
    }
    if (manual.current) {
      tracked.current = { id: reply?.id ?? '', consumed: 0, text: '', started: false, suppressed: true }; return
    }
    if (!profile.auto_speak) { stop(); return }
    if ((!active || blockNew) && (!tracked.current.started || tracked.current.id !== reply?.id)) {
      tracked.current = { id: reply?.id ?? '', consumed: 0, text: '', started: false, suppressed: true }; return
    }
    if (!reply) { stop(); tracked.current.id = ''; return }
    if (reply.proactive) { stop(); tracked.current.suppressed = true; return }
    if (tracked.current.id !== reply.id) {
      stop()
      tracked.current = { id: reply.id, consumed: 0, text: '', started: false, suppressed: reply.status !== 'running' }
    }
    if (reply.status === 'stopped' || reply.status === 'error') { stop(); tracked.current.suppressed = true; return }
    if (!settings || tracked.current.suppressed) return
    const final = reply.status === 'succeeded'
    const text = speechText(reply.content, final)
    if (!text.startsWith(tracked.current.text.slice(0, tracked.current.consumed))) { stop(); tracked.current.suppressed = true; return }
    tracked.current.text = text
    const { sentences, rest } = takeSpeechSentences(text.slice(tracked.current.consumed), final, !tracked.current.started, streamingSpeechLimit(settings))
    tracked.current.consumed = text.length - rest.length
    if (sentences.length) {
      tracked.current.started = true
      const pending = recovery.current
      if (pending) {
        if (!pending.readingId) { pending.remaining.push(...sentences); setHasRemaining(true) }
      } else {
        setError('')
        const current = player.current || makePlayer(settings)
        current.enqueue(sentences, { final })
      }
    } else if (final) player.current?.enqueue([], { final })
    // Queue ownership is scoped to the existing chat/session, not every token render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reply?.id, reply?.content, reply?.status, reply?.proactive, profile.auto_speak, settings, active, muted, blockNew])

  return error ? <div className="digital-person-speech-failure">
    <span role="alert" className="digital-person-speech-error">{localizeErrorDisplay(error)}</span>
    {hasRemaining && active && !muted && !blockNew && manualEnabled &&
      <Button type="button" variant="ghost" disabled={playing} onClick={() => void retry()}>{t('common.retry')}</Button>}
  </div> : null
}
