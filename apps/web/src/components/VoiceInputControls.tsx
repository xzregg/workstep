import type { useVoiceInput } from '../hooks/useVoiceInput'
import { useI18n } from '../i18n'
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
export default function VoiceInputControls({ voice, variant = 'composer' }: { voice: VoiceInputState; variant?: 'composer' | 'test' }) {
  const { t } = useI18n()
  if (!voice.mode && !voice.active && !voice.error) return null
  const error = voice.error.startsWith('speech.') ? t(voice.error as Parameters<typeof t>[0]) : voice.error
  return <section className="voice-input" aria-label={t('speech.title')}>
    <div className="voice-input-status" role="status">
      {(['requesting', 'preparing', 'finishing'].includes(voice.phase) || (voice.phase === 'recording' && voice.catchingUp)) && <span className="task-status-spinner" />}
      {voice.phase === 'recording' && <meter min={0} max={1} value={voice.level} aria-label={t('speech.volume')} />}
      <span>{t(voice.phase === 'recording' && voice.catchingUp ? 'speech.catchingUp' : `speech.${voice.phase}`)}</span>
      {voice.phase === 'recording' && <time>{voice.seconds}s / 120s</time>}
    </div>
    {voice.text && <div className="voice-input-transcript" aria-live="polite">{voice.text}</div>}
    {voice.notice && <p role="status">{t(voice.notice as Parameters<typeof t>[0])}</p>}
    {error && <p className="voice-input-error" role="alert">{error}</p>}
    <div className="voice-input-actions">
      {voice.phase === 'idle' && <button type="button" onClick={() => void voice.start()}>{t('speech.start')}</button>}
      {voice.phase === 'recording' && <button type="button" onClick={voice.finish}>{t('speech.finish')}</button>}
      {variant === 'composer' && voice.phase === 'error' && voice.text && <button type="button" onClick={voice.recover}>{t('speech.recover')}</button>}
      <div className="voice-input-secondary-actions">
        {variant === 'composer' && !voice.active && <button type="button" onClick={openSpeechSettings}>{t('speech.settings')}</button>}
        <button type="button" onClick={() => { voice.cancel(); voice.setMode(false) }}>{t(voice.active || voice.error ? 'speech.cancel' : 'speech.keyboard')}</button>
      </div>
    </div>
  </section>
}
