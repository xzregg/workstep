import { useEffect, useState } from 'react'
import { digitalPersonApi, type DigitalPersonProfile } from '../api/digitalPerson'
import { useI18n } from '../i18n'
import Button from './Button'
import Input from './Input'
import Spinner from './Spinner'
import DigitalPersonVoice from './digital-person/DigitalPersonVoice'
import { DIGITAL_PERSON_CHANGED } from './digital-person/useDigitalPerson'

export default function VoiceOutputSettings({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { t } = useI18n()
  const [profile, setProfile] = useState<DigitalPersonProfile | null>(null)
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false)
  const [error, setError] = useState(''), [revision, setRevision] = useState(0)
  const values = profile && JSON.stringify([profile.voice_name || '', profile.voice_rate ?? 1, profile.expression || 'neutral', profile.auto_speak ?? false])
  const dirty = !!profile && values !== saved
  useEffect(() => { onDirtyChange(dirty || saving) }, [dirty, saving, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    digitalPersonApi.get().then(value => {
      if (!active) return
      setProfile(value)
      setSaved(JSON.stringify([value.voice_name || '', value.voice_rate ?? 1, value.expression || 'neutral', value.auto_speak ?? false]))
    }).catch(reason => { if (active) setError(String(reason instanceof Error ? reason.message : reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [revision])
  const save = async () => {
    if (!profile || saving) return
    setSaving(true); setError('')
    try {
      const current = await digitalPersonApi.get()
      await digitalPersonApi.save({ ...current, voice_name: profile.voice_name, voice_rate: profile.voice_rate, expression: profile.expression, auto_speak: profile.auto_speak })
      setSaved(values!)
      window.dispatchEvent(new Event(DIGITAL_PERSON_CHANGED))
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)) }
    finally { setSaving(false) }
  }
  return <section className="speech-output-settings" aria-label={t('speech.tab_output')}>
    <p>{t('speech.outputSystemHint')}</p>
    {loading ? <span role="status"><Spinner />{t('common.loading')}</span> : profile && <>
      <fieldset disabled={saving}>
        <DigitalPersonVoice profile={profile} onChange={patch => setProfile({ ...profile, ...patch })} />
        <label>{t('digitalPerson.voiceRate')}<Input type="number" min={.5} max={2} step={.1} value={profile.voice_rate ?? 1} onChange={event => setProfile({ ...profile, voice_rate: Number(event.target.value) })} /></label>
        <label><input type="checkbox" checked={profile.auto_speak ?? false} onChange={event => setProfile({ ...profile, auto_speak: event.target.checked })} />{t('digitalPerson.autoSpeak')}</label>
      </fieldset>
      <Button data-save-output variant="primary" loading={saving} disabled={!dirty || !Number.isFinite(profile.voice_rate ?? 1) || (profile.voice_rate ?? 1) < .5 || (profile.voice_rate ?? 1) > 2} onClick={() => void save()}>{t('common.save')}</Button>
    </>}
    {error && <p role="alert">{error}{!profile && <Button onClick={() => setRevision(value => value + 1)}>{t('common.retry')}</Button>}</p>}
  </section>
}
