import { useEffect, useRef, useState } from 'react'
import { OUTPUT_CHANGED, type OutputSettings } from '../api/speechOutput'
import { loadSpeechOutputSettings, invalidateSpeechOutputSettings } from '../utils/speechOutputSettings'
import { completedSpeechBatches, SpeechOutputPlayer, speechText } from '../utils/speechOutput'
import { useI18n, localizeErrorDisplay } from '../i18n'
import Button from './Button'
import Icon from './Icon'
import Spinner from './Spinner'
import './MessageSpeechButton.css'

/** Shared reply action; one settings request per project, one playback across messages. */
export default function MessageSpeechButton({ content, projectId = '' }: { content: string; projectId?: string }) {
  const { t } = useI18n()
  const text = speechText(content).trim()
  const [settings, setSettings] = useState<OutputSettings | null>(null)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState('')
  const [showError, setShowError] = useState(false)
  const player = useRef<SpeechOutputPlayer | null>(null)
  const generation = useRef(0)
  const stop = () => { generation.current++; player.current?.stop(); player.current = null; setPlaying(false) }
  useEffect(() => {
    let alive = true, revision = 0
    const load = () => {
      const current = ++revision
      stop(); setSettings(null)
      void loadSpeechOutputSettings(projectId).then(value => { if (alive && current === revision) { setSettings(value); setError('') } })
        .catch(reason => { if (alive && current === revision) setError(reason instanceof Error ? reason.message : String(reason)) })
    }
    const changed = (event: Event) => {
      invalidateSpeechOutputSettings(event)
      load()
    }
    const hidden = () => { if (document.hidden) stop() }
    load()
    window.addEventListener(OUTPUT_CHANGED, changed)
    document.addEventListener('visibilitychange', hidden)
    return () => { alive = false; stop(); window.removeEventListener(OUTPUT_CHANGED, changed); document.removeEventListener('visibilitychange', hidden) }
  }, [projectId, content])

  const toggle = async () => {
    if (playing) { stop(); return }
    stop(); setError(''); setShowError(true); setPlaying(true)
    const request = generation.current
    try {
      const config = settings ?? await loadSpeechOutputSettings(projectId)
      if (request !== generation.current) return
      setSettings(config)
      const current = new SpeechOutputPlayer({ settings: config, projectId, completeReply: true,
        onState: value => { if (player.current === current) setPlaying(value) },
        onError: reason => { if (player.current === current) { setPlaying(false); setError(reason.message) } },
      })
      player.current = current
      await current.unlock()
      if (player.current === current) current.enqueue(completedSpeechBatches(text), { final: true })
    } catch (reason) {
      if (request !== generation.current) return
      stop(); setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  return <>
    <Button variant="ghost" className="message-speech-button chat-message-action" aria-label={t(playing ? 'tts.stop' : 'tts.play')}
      disabled={!text} title={error || t(playing ? 'tts.stop' : 'tts.play')} onClick={() => void toggle()}>
      {playing ? <Spinner size={12} /> : <Icon name="volume" size={14} />}
    </Button>
    {showError && error && <span className="message-speech-error" role="alert">{localizeErrorDisplay(error)}</span>}
  </>
}
