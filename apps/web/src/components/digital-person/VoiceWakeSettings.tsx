import { useEffect, useState } from 'react'
import { VOICE_WAKE_CHANGED, voiceWakeApi, type VoiceWakeDraft } from '../../api/digitalPerson'
import type { WakeGreetingVoice } from '../../audio/wakeGreeting'
import { useI18n, localizeErrorDisplay } from '../../i18n'
import Button from '../Button'
import Input from '../Input'
import Select from '../Select'
import Spinner from '../Spinner'
import DigitalPersonWake from './DigitalPersonWake'
import WakePreferenceSwitch from './WakePreferenceSwitch'
import { getLegacyWakeGreeting, getLegacyWakeSoundEnabled, useWakeTest, wakeGreetingMaxLength } from './wakePreferences'
import './VoiceWakeSettings.css'

type WakeSettingsDraft = VoiceWakeDraft & { soundEnabled: boolean; greeting: string }

export default function VoiceWakeSettings({ onDirtyChange, onBusyChange, active = true, microphoneBusy = false, voice }: {
  onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; active?: boolean; microphoneBusy?: boolean
  voice?: WakeGreetingVoice
}) {
  const { t } = useI18n()
  const testing = useWakeTest() !== null
  const [saved, setSaved] = useState<WakeSettingsDraft | null>(null)
  const [draft, setDraft] = useState<WakeSettingsDraft | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(false)
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => { onBusyChange?.(saving) }, [saving, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  const keywordDirty = draft?.keyword.trim() !== saved?.keyword || draft?.sensitivity !== saved?.sensitivity
  const greetingDirty = draft?.greeting.trim() !== saved?.greeting
  const soundDirty = draft?.soundEnabled !== saved?.soundEnabled
  const dirty = keywordDirty || greetingDirty || soundDirty
  useEffect(() => { onDirtyChange?.(dirty || saving) }, [dirty, saving, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    voiceWakeApi.get().then(value => {
      if (!alive) return
      const config = { keyword: value.keyword, sensitivity: value.sensitivity,
        soundEnabled: value.sound_enabled ?? true, greeting: value.greeting ?? '' }
      setSaved(config)
      setDraft({ ...config, soundEnabled: value.sound_enabled ?? getLegacyWakeSoundEnabled(),
        greeting: value.greeting ?? getLegacyWakeGreeting().trim() })
    })
      .catch(reason => { if (alive) setError(String(reason instanceof Error ? reason.message : reason)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [revision])
  const save = async () => {
    if (!draft || !dirty || saving || testing || draft.keyword.trim().length < 2) return
    setSaving(true);setError('');setNotice(false)
    try {
      const value = await voiceWakeApi.save({ keyword: draft.keyword.trim(), sensitivity: draft.sensitivity,
        sound_enabled: draft.soundEnabled, greeting: draft.greeting.trim() })
      const config = { keyword: value.keyword, sensitivity: value.sensitivity,
        soundEnabled: value.sound_enabled ?? true, greeting: value.greeting ?? '' }
      setSaved(config)
      setDraft(config)
      setNotice(true)
      window.dispatchEvent(new Event(VOICE_WAKE_CHANGED))
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)) }
    finally { setSaving(false) }
  }
  return <section className="voice-wake-settings" aria-label={t('voiceWake.title')}>
    <WakePreferenceSwitch className="voice-wake-switch-row" label={t('voiceWake.enable')} />
    {loading ? <div role="status"><Spinner />{t('common.loading')}</div> : draft && <>
      <label>{t('voiceWake.keyword')}<Input name="wake_keyword" value={draft.keyword} maxLength={40} disabled={saving || testing} onChange={event=>{setDraft({...draft,keyword:event.target.value});setNotice(false)}} /></label>
      <label>{t('voiceWake.sensitivity')}<Select value={draft.sensitivity} disabled={saving || testing} onChange={event=>{setDraft({...draft,sensitivity:event.target.value as VoiceWakeDraft['sensitivity']});setNotice(false)}}>
        {(['low','balanced','high'] as const).map(value=><option value={value} key={value}>{t(`voiceWake.${value}`)}</option>)}
      </Select></label>
      <p>{t('voiceWake.sensitivityHint')}</p>
      <label className="voice-wake-sound">
        <input type="checkbox" name="wake_sound" checked={draft.soundEnabled} disabled={saving || testing}
          onChange={event => { setDraft({ ...draft, soundEnabled: event.currentTarget.checked }); setNotice(false) }} />
        {t('voiceWake.sound')}
      </label>
      <label className="voice-wake-greeting">
        <span>{t('voiceWake.greeting')}</span>
        <Input name="wake_greeting" value={draft.greeting} maxLength={wakeGreetingMaxLength} placeholder={t('voiceWake.defaultSound')}
          disabled={!draft.soundEnabled || saving || testing}
          onChange={event => { setDraft({ ...draft, greeting: event.currentTarget.value }); setNotice(false) }} />
      </label>
      <div className="voice-wake-actions">
        {active && <DigitalPersonWake draft={draft} voice={voice} blocked={microphoneBusy || saving || draft.keyword.trim().length < 2} />}
        <Button data-save-wake variant="primary" loading={saving} disabled={testing || !dirty || draft.keyword.trim().length < 2} onClick={()=>void save()}>{t('common.save')}</Button>
      </div>
    </>}
    {notice && <p role="status">{t('voiceWake.saved')}</p>}
    {error && <div role="alert">{localizeErrorDisplay(error)}{!draft && <Button onClick={()=>setRevision(value=>value+1)}>{t('common.retry')}</Button>}</div>}
  </section>
}
