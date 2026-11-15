import DigitalPersonWake from './DigitalPersonWake'
import { useEffect, useState } from 'react'
import { voiceWakeApi, type VoiceWakeDraft } from '../../api/digitalPerson'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Input from '../Input'
import Select from '../Select'
import Spinner from '../Spinner'
import './VoiceWakeSettings.css'

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}]/gu, '')
export default function VoiceWakeSettings({ onDirtyChange, onBusyChange, onTest, testDisabled = false, sample = null, parametersOnly = false, listeningDisabled = false, streamingUnavailable = false }: {
  onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; onTest?: () => void; testDisabled?: boolean; sample?: string | null; parametersOnly?: boolean; listeningDisabled?: boolean; streamingUnavailable?: boolean
}) {
  const { t } = useI18n()
  const [saved, setSaved] = useState<VoiceWakeDraft | null>(null)
  const [draft, setDraft] = useState<VoiceWakeDraft | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(false)
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => { onBusyChange?.(saving) }, [saving, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft)
  useEffect(() => { onDirtyChange?.(dirty || saving) }, [dirty, saving, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    voiceWakeApi.get().then(value => { if (alive) { const config = {keyword:value.keyword,sensitivity:value.sensitivity};setSaved(config);setDraft(config) } })
      .catch(reason => { if (alive) setError(String(reason instanceof Error ? reason.message : reason)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [revision])
  const save = async () => {
    if (!draft || saving) return
    setSaving(true);setError('');setNotice(false)
    try {
      const value = await voiceWakeApi.save({keyword:draft.keyword.trim(),sensitivity:draft.sensitivity})
      const config = {keyword:value.keyword,sensitivity:value.sensitivity};setSaved(config);setDraft(config);setNotice(true)
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)) }
    finally { setSaving(false) }
  }
  return <section className="voice-wake-settings" aria-label={t('voiceWake.title')}>
    {!parametersOnly && <DigitalPersonWake keyword={saved?.keyword} sensitivity={saved?.sensitivity} disabled={listeningDisabled} />}
    {!parametersOnly && listeningDisabled && <p>{t(streamingUnavailable ? 'asr.wakeNeedsStreaming' : 'asr.wakeNeedsInput')}</p>}
    {loading ? <div role="status"><Spinner />{t('common.loading')}</div> : draft && <>
      <label>{t('voiceWake.keyword')}<Input value={draft.keyword} maxLength={40} disabled={saving} onChange={event=>{setDraft({...draft,keyword:event.target.value});setNotice(false)}} /></label>
      <label>{t('voiceWake.sensitivity')}<Select value={draft.sensitivity} disabled={saving} onChange={event=>{setDraft({...draft,sensitivity:event.target.value as VoiceWakeDraft['sensitivity']});setNotice(false)}}>
        {(['low','balanced','high'] as const).map(value=><option value={value} key={value}>{t(`voiceWake.${value}`)}</option>)}
      </Select></label>
      <p>{t('voiceWake.sensitivityHint')}</p>
      <div className="voice-wake-actions"><Button data-save-wake variant="primary" loading={saving} disabled={!dirty || draft.keyword.trim().length < 2} onClick={()=>void save()}>{t('common.save')}</Button>
        {!parametersOnly && <Button data-test-wake disabled={testDisabled || saving || draft.keyword.trim().length < 2} onClick={onTest}>{t('voiceWake.test')}</Button>}</div>
      {!parametersOnly && <p>{t('voiceWake.testHint')}</p>}
      {!parametersOnly && sample !== null && <div role="status" className="voice-wake-result"><strong>{t(normalize(draft.keyword) && normalize(sample).includes(normalize(draft.keyword)) ? 'voiceWake.matched' : 'voiceWake.unmatched')}</strong><p>{sample || t('speech.testNoSpeech')}</p></div>}
    </>}
    {notice && <p role="status">{t('voiceWake.saved')}</p>}
    {error && <div role="alert">{error}{!draft && <Button onClick={()=>setRevision(value=>value+1)}>{t('common.retry')}</Button>}</div>}
  </section>
}
