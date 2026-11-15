import { useEffect, useRef, useState } from 'react'
import type { DigitalPersonProfile } from '../../api/digitalPerson'
import { OUTPUT_CHANGED, type OutputSettings } from '../../api/speechOutput'
import type { AssistantChatMessage } from '../../stores/assistantStore'
import { SpeechOutputPlayer, speechText, takeSpeechSentences } from '../../utils/speechOutput'
import { loadSpeechOutputSettings, invalidateSpeechOutputSettings } from '../../utils/speechOutputSettings'
import {DIGITAL_OUTPUT_FRAME,STOP_DIGITAL_SPEECH,type DigitalOutputFrame} from './digitalPersonVoiceEvents'
import './DigitalPersonSpeech.css'

/** Owns playback only; reads the existing chat messages without another session/store. */
export default function DigitalPersonSpeech({ profile, projectId, sessionId, messages, active, muted = false }: {
  profile: DigitalPersonProfile; projectId: string; sessionId: string | null
  messages: AssistantChatMessage[]; active: boolean; hideControls?: boolean; muted?: boolean
}) {
  const [settings, setSettings] = useState<OutputSettings | null>(null)
  const [playing, setPlaying] = useState(false), [error, setError] = useState('')
  const player = useRef<SpeechOutputPlayer | null>(null)
  const tracked = useRef({ id: '', consumed: 0, text: '', suppressed: false })
  const outputFrame=useRef({playing:false,level:0,busy:false})
  const publishOutput=()=>window.dispatchEvent(new window.CustomEvent<DigitalOutputFrame>(DIGITAL_OUTPUT_FRAME,{detail:{projectId,sessionId,...outputFrame.current}}))
  const latest = messages[messages.length - 1]
  const reply = latest?.role === 'assistant' ? latest : null
  const stop = () => { player.current?.stop(); player.current = null }

  useEffect(() => {
    let alive = true
    const load = (event?: Event) => {
      if (event) invalidateSpeechOutputSettings(event)
      stop(); tracked.current.suppressed = true
      void loadSpeechOutputSettings(projectId).then(settings => { if (alive) { setSettings(settings); setError('') } })
        .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)) })
    }
    load()
    window.addEventListener(OUTPUT_CHANGED, load)
    return () => { alive = false; stop(); window.removeEventListener(OUTPUT_CHANGED, load) }
  }, [projectId])
  useEffect(() => {
    stop(); tracked.current = { id: '', consumed: 0, text: '', suppressed: false }
    return stop
  }, [sessionId, active])
  useEffect(() => {
    window.dispatchEvent(new window.CustomEvent('workstep:digital-person-speaking', { detail: playing }))
    return () => { window.dispatchEvent(new window.CustomEvent('workstep:digital-person-speaking', { detail: false })) }
  }, [playing])

  useEffect(()=>{
    const interrupt=(event:Event)=>{
      const detail=(event as CustomEvent).detail
      if(detail?.projectId!==projectId||detail?.sessionId!==sessionId)return
      tracked.current.suppressed=true;stop();outputFrame.current={playing:false,level:0,busy:false};publishOutput()
    }
    window.addEventListener(STOP_DIGITAL_SPEECH,interrupt)
    return()=>window.removeEventListener(STOP_DIGITAL_SPEECH,interrupt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[projectId,sessionId])

  const makePlayer = () => {
    const result = new SpeechOutputPlayer({ projectId, coalesce:true,
      settings: { ...settings!, rate: profile.voice_rate ?? settings!.rate }, systemVoice: profile.voice_name,
      onPlayback: value=>{outputFrame.current.playing=value;publishOutput()},
      onLevel: value=>{outputFrame.current.level=value;publishOutput()},
      onInterrupt: () => { tracked.current.suppressed = true },
      onState: value=>{setPlaying(value);outputFrame.current.busy=value;publishOutput()}, onError: reason => { tracked.current.suppressed = true; setError(reason.message) } })
    player.current = result
    return result
  }

  useEffect(() => {
    if (muted) {
      stop(); tracked.current = { id: reply?.id ?? '', consumed: 0, text: '', suppressed: true }; return
    }
    if (!active || !profile.auto_speak) { stop(); return }
    if (!reply) { stop(); tracked.current.id = ''; return }
    if (reply.proactive) { stop(); tracked.current.suppressed = true; return }
    if (tracked.current.id !== reply.id) {
      stop()
      tracked.current = { id: reply.id, consumed: 0, text: '', suppressed: reply.status !== 'running' }
    }
    if (reply.status === 'stopped' || reply.status === 'error') { stop(); tracked.current.suppressed = true; return }
    if (!settings || tracked.current.suppressed) return
    const text = speechText(reply.content)
    if (!text.startsWith(tracked.current.text)) { stop(); tracked.current.suppressed = true; return }
    tracked.current.text = text
    const { sentences, rest } = takeSpeechSentences(text.slice(tracked.current.consumed), reply.status === 'succeeded')
    tracked.current.consumed = text.length - rest.length
    if (sentences.length) {
      setError('')
      const current = player.current || makePlayer()
      current.enqueue(sentences)
    }
    // Queue ownership is scoped to the existing chat/session, not every token render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reply?.id, reply?.content, reply?.status, profile.auto_speak, settings, active, muted])

  return error ? <span role="alert" className="digital-person-speech-error">{error}</span> : null
}
