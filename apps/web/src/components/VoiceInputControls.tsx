import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import type { useVoiceInput } from '../hooks/useVoiceInput'
import { useI18n, localizeErrorDisplay } from '../i18n'
import { openSpeechSettings } from '../api/speech'
import Icon from './Icon'
import './VoiceInput.css'

export type VoiceInputState = ReturnType<typeof useVoiceInput>
export function VoiceMicrophone({ voice, disabled }: { voice: VoiceInputState; disabled: boolean }) {
  const { t } = useI18n()
  return <button type="button" className="voice-microphone" aria-label={t('speech.title')} title={t('speech.title')}
    disabled={disabled || voice.active} aria-pressed={voice.mode}
    onClick={() => void voice.start()}>
    <Icon name="mic" size={18} />
  </button>
}
export default function VoiceInputControls({ voice, variant = 'composer', compact = false, draftPreview }: {
  voice: VoiceInputState; variant?: 'composer' | 'test'; compact?: boolean; draftPreview?: string
}) {
  const { t } = useI18n()
  const transcriptRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const transcript = transcriptRef.current
    if (compact && transcript) transcript.scrollTop = transcript.scrollHeight
  }, [compact, voice.text])
  if (!voice.mode && !voice.active && !voice.error) return null
  const error = voice.error.startsWith('speech.') ? t(voice.error as Parameters<typeof t>[0]) : voice.error
  const recording = voice.phase === 'recording'
  const elapsed = `${String(Math.floor(voice.seconds / 60)).padStart(2, '0')}:${String(voice.seconds % 60).padStart(2, '0')}`
  return <section className="voice-input" data-compact={compact || undefined} aria-label={t('speech.title')}>
    {draftPreview && <div className="voice-input-draft">{draftPreview}</div>}
    <div className="voice-input-status">
      {(['requesting', 'preparing', 'finishing'].includes(voice.phase) || (recording && voice.catchingUp)) && <span className="task-status-spinner" aria-hidden="true" />}
      {recording && (compact
        ? <div className="voice-input-waveform" role="meter" aria-label={t('speech.volume')} aria-valuemin={0} aria-valuemax={1}
            aria-valuenow={voice.level} data-audible={voice.level >= 0.08 || undefined}
            style={{ '--voice-level': voice.level } as CSSProperties}>
            {Array.from({ length: 15 }, (_, index) => <span key={index} />)}
          </div>
        : <meter min={0} max={1} value={voice.level} aria-label={t('speech.volume')} />)}
      <span role="status" data-listening={compact && recording && !voice.catchingUp || undefined}>
        {t(recording && voice.catchingUp ? 'speech.catchingUp' : `speech.${voice.phase}`)}
      </span>
      {recording && <time dateTime={`PT${voice.seconds}S`}>{compact ? elapsed : `${voice.seconds}s / 120s`}</time>}
    </div>
    {(compact || voice.text) && <div ref={transcriptRef} className="voice-input-transcript" aria-live="polite">{voice.text}</div>}
    {voice.notice && <p className="voice-input-notice" role="status">{t(voice.notice as Parameters<typeof t>[0])}</p>}
    {error && <p className="voice-input-error" role="alert">{localizeErrorDisplay(error)}</p>}
    <div className="voice-input-actions">
      {voice.phase === 'idle' && <button type="button" onClick={() => void voice.start()}>{t('speech.start')}</button>}
      {variant === 'composer' && voice.phase === 'error' && voice.text && <button type="button" onClick={voice.recover}>{t('speech.recover')}</button>}
      <div className="voice-input-secondary-actions">
        {variant === 'composer' && !voice.active && <button type="button" onClick={openSpeechSettings}>{t('speech.settings')}</button>}
        <button type="button" onClick={() => { voice.cancel(); voice.setMode(false) }}><span>{t(voice.active || voice.error ? 'speech.cancel' : 'speech.keyboard')}</span></button>
        {recording && <button type="button" className="voice-input-finish" onClick={voice.finish}><span>{t('speech.finish')}</span></button>}
      </div>
    </div>
  </section>
}
