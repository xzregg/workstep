import { useEffect, useId, useRef, useState } from 'react'
import { readSpeechSecret, type SpeechDestination, type SpeechSecret, type SpeechSecrets } from '../api/speechCredentials'
import { useI18n, localizeErrorDisplay } from '../i18n'
import Button from './Button'
import Input from './Input'
import './SpeechSecretField.css'

export default function SpeechSecretField({ kind, connection, field, label, placeholder, onChange }: {
  kind: 'speech' | 'speech-output'
  connection: SpeechDestination & SpeechSecrets
  field: SpeechSecret
  label: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const [display, setDisplay] = useState<{ source: 'draft' } | { source: 'saved'; value: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  const draft = connection[field]
  const saved = !!connection[`has_${field}`]
  const visible = display?.source === 'saved' || (display?.source === 'draft' && draft != null)
  const action = t(visible ? 'providerSettings.hide' : 'providerSettings.reveal')
  const toggle = async () => {
    setError('')
    if (visible || draft != null) {
      setDisplay(visible ? null : { source: 'draft' })
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setLoading(true)
    try {
      const { value } = await readSpeechSecret(kind, connection, field, controller.signal)
      if (controller.signal.aborted) return
      setDisplay({ source: 'saved', value })
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  return <div className="speech-secret-field">
    <label htmlFor={id}>{label}</label>
    <div className="speech-secret-controls">
      <Input id={id} type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false}
        value={draft ?? (display?.source === 'saved' ? display.value : '')}
        placeholder={draft == null && saved ? t('tts.secretSaved') : placeholder}
        onChange={event => {
          pending.current?.abort()
          setLoading(false)
          setDisplay(visible ? { source: 'draft' } : null)
          setError('')
          onChange(event.target.value)
        }} />
      <Button type="button" loading={loading} disabled={!visible && !(draft ?? saved)}
        aria-label={`${action} ${label}`} onClick={() => void toggle()}>{action}</Button>
    </div>
    {error && <p role="alert">{localizeErrorDisplay(error)}</p>}
  </div>
}
