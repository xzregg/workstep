import { useEffect, useRef, useState } from 'react'
import { digitalPersonApi, type DigitalPersonProfile } from '../api/digitalPerson'
import { outputConfigured, speechOutputApi, type OutputSettings, type OutputStatus } from '../api/speechOutput'
import { SpeechOutputPlayer, speechText, takeSpeechSentences } from '../utils/speechOutput'
import { useI18n } from '../i18n'
import Button from './Button'
import Input from './Input'
import Select from './Select'
import Textarea from './Textarea'
import Spinner from './Spinner'
import ConfirmDialog from './ConfirmDialog'
import DigitalPersonVoice from './digital-person/DigitalPersonVoice'
import VoiceOutputConnection from './VoiceOutputConnection'
import VoiceStyleSettings from './VoiceStyleSettings'
import RadioCardGroup from './RadioCardGroup'
import { DIGITAL_PERSON_CHANGED } from './digital-person/useDigitalPerson'
import './VoiceOutputSettings.css'

const busyStages = ['resolving', 'downloading', 'installing']
const mib = (n: number) => `${(n / 1048576).toFixed(1)} MiB`
const signature = (draft: OutputSettings | null, profile: DigitalPersonProfile | null) => JSON.stringify([
  draft, profile?.voice_name || '', profile?.expression || 'neutral', profile?.auto_speak ?? false,
])

export default function VoiceOutputSettings({ onDirtyChange, onBusyChange, initialProfile, onSaved, disabled = false, parametersOnly = false }: {
  onDirtyChange: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
  initialProfile?: DigitalPersonProfile
  onSaved?: (profile: DigitalPersonProfile) => void
  parametersOnly?: boolean
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [status, setStatus] = useState<OutputStatus | null>(null), [draft, setDraft] = useState<OutputSettings | null>(null)
  const [profile, setProfile] = useState<DigitalPersonProfile | null>(null), [saved, setSaved] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [acting, setActing] = useState(false)
  const [playing, setPlaying] = useState(false), [revision, setRevision] = useState(0), [deleteId, setDeleteId] = useState<string | null>(null)
  const [sample, setSample] = useState(t('tts.sample'))
  const player = useRef<SpeechOutputPlayer | null>(null), alive = useRef(true)
  const profileAtMount = useRef(initialProfile)
  useEffect(() => { onBusyChange?.(saving) }, [saving, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  const dirty = !!draft && signature(draft, profile) !== saved
  const installing = !!status?.models.some(model => busyStages.includes(model.install.stage))
  const blocked = saving || acting || playing || disabled
  const selected = status?.models.find(model => model.id === draft?.model_id)
  const supportsInstructions = !!draft && (draft.mode === 'local' ? !!selected?.instructions :
    draft.mode === 'cloud' && draft.provider === 'qwen' && draft.model.includes('instruct') ||
    draft.mode === 'remote' && draft.provider === 'voicebox' && draft.engine === 'qwen_custom_voice' && draft.model.startsWith('1.7'))
  const valid = !!draft && outputConfigured(draft) && (draft.mode !== 'local' ||
    !!selected?.installed && selected.voices.some(v => v.id === draft.voice) && (!selected.voice_design || !!draft.instructions.trim()))

  useEffect(() => { onDirtyChange(dirty || saving) }, [dirty, saving, onDirtyChange])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; player.current?.stop(); onDirtyChange(false) }
  }, [onDirtyChange])
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    Promise.all([speechOutputApi.status(), profileAtMount.current ? Promise.resolve(profileAtMount.current) : digitalPersonApi.get()]).then(([result, value]) => {
      if (!active) return
      const settings = { ...result.settings, rate: value.voice_rate ?? result.settings.rate }
      setStatus(result); setDraft(settings); setProfile(value); setSaved(signature(settings, value))
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [revision])
  useEffect(() => {
    if (!installing) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const next = await speechOutputApi.status(); if (!cancelled) setStatus(next) }
      catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) }
      if (!cancelled) timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [installing])

  const set = (patch: Partial<OutputSettings>) => { setDraft(current => current && ({ ...current, ...patch })); setNotice('') }
  const modelAction = async (action: 'download' | 'cancel' | 'delete' | 'unload', id?: string) => {
    setActing(true); setError('')
    try { const result = await speechOutputApi.modelAction(action, id); if (alive.current) setStatus(result) }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (alive.current) setActing(false) }
  }
  const save = async () => {
    if (!draft || !profile) return
    setSaving(true); setError(''); setNotice('')
    try {
      const current = await digitalPersonApi.get()
      const result = await speechOutputApi.save(draft)
      const nextProfile = { ...current, voice_name: profile.voice_name, voice_rate: draft.rate, expression: profile.expression, auto_speak: profile.auto_speak }
      await digitalPersonApi.save(nextProfile)
      if (!alive.current) return
      setDraft(result); setProfile(nextProfile); setSaved(signature(result, nextProfile)); setNotice(t('tts.saved'))
      onSaved?.(nextProfile)
      window.dispatchEvent(new Event(DIGITAL_PERSON_CHANGED))
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (alive.current) setSaving(false) }
  }
  const stop = () => { player.current?.stop(); player.current = null; setPlaying(false) }
  const test = async () => {
    if (!draft || !profile) return
    stop(); setError(''); setNotice('')
    const next = new SpeechOutputPlayer({ settings: draft, preview: true, systemVoice: profile.voice_name,
      onState: active => { if (alive.current) setPlaying(active) }, onError: reason => { if (alive.current) setError(reason.message) } })
    player.current = next
    try { await next.unlock(); if (player.current === next) next.enqueue(takeSpeechSentences(speechText(sample), true).sentences) }
    catch (reason) { next.stop(); if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  return <section className="speech-output-settings" aria-label={t('speech.tab_output')}>
    {loading ? <span role="status"><Spinner />{t('common.loading')}</span> : draft && profile && status && <>
      <fieldset disabled={blocked}>
        {!parametersOnly && <RadioCardGroup label={t('tts.mode')} value={draft.mode} disabled={blocked}
          options={(['system', 'local', 'cloud', 'remote'] as const).map(mode => ({ value: mode, label: t(`tts.mode_${mode}`), description: t(`speechModes.${mode}`) }))}
          onChange={value => {
          const mode = value as OutputSettings['mode'], id = mode === 'remote' ? 'voicebox' : 'qwen'
          const p = status.providers.find(p => p.id === id)!
          set({ mode, voice: mode === 'local' ? (draft.model_id === 'kokoro-v1' ? '46' : selected?.voices[0]?.id || '0') : p.voice,
            provider: id, model: p.model, base_url: p.base_url, api_key: null, secret_id: null, secret_key: null,
            has_api_key: false, has_secret_id: false, has_secret_key: false, instructions: '', region: 'beijing' })
        }} />}
        {draft.mode === 'system' && <DigitalPersonVoice preview={false} profile={{ ...profile, voice_rate: draft.rate }} onChange={patch => setProfile({ ...profile, ...patch })} />}
        {draft.mode === 'local' && <>
          {!parametersOnly && <label>{t('tts.model')}<Select data-output-model value={draft.model_id} onChange={event => {
            const model = status.models.find(m => m.id === event.target.value)!
            set({ model_id: model.id, voice: model.voices[0].id, instructions: '' })
          }}>{status.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</Select></label>}
          <label>{t('digitalPerson.voiceName')}<Select value={draft.voice} onChange={e => set({ voice: e.target.value })}>{selected?.voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></label>
          {selected?.voice_design && <p className="speech-output-hint">{t('tts.voiceDesignHint')}</p>}
          {!parametersOnly && <>
          <div className="speech-output-actions"><span>{t('speech.service')}: {t(`speech.service_${status.service}`)}</span><Button disabled={status.service !== 'ready'} onClick={() => void modelAction('unload')}>{t('tts.unload')}</Button></div>
          <details className="speech-output-model-manager" open={!selected?.installed || installing}>
          <summary>{t('tts.manageModels')}</summary>
          <p className="speech-output-hint">{t('tts.localHint')}</p>
          <div className="speech-output-models">{status.models.map(model => {
            const busy = busyStages.includes(model.install.stage)
            return <section className="speech-output-model" key={model.id} data-current={draft.model_id === model.id || undefined}>
              <div className="speech-output-model-heading"><strong>{model.name}</strong><span>{mib(model.model_bytes)}</span></div>
              <div className="speech-output-model-meta"><span>{model.installed ? t('speech.installedModel') : t('tts.notInstalled')}</span><span>{t('tts.sentence')}</span><a href={model.license_url} target="_blank" rel="noreferrer">{t('tts.source')}</a></div>
              {model.requirements && <p className="speech-output-hint">{model.requirements}</p>}
              {busy && <div className="speech-output-progress" role="status"><Spinner /><span>{model.runtime === 'qwen' && model.install.stage === 'installing' ? t('tts.installingRuntime') : t(`speech.stage_${model.install.stage}` as never)}</span><progress max={model.install.total_bytes || 1} value={model.install.total_bytes ? model.install.downloaded_bytes : undefined} /><span>{mib(model.install.downloaded_bytes)}{model.install.total_bytes ? ` / ${mib(model.install.total_bytes)}` : ''}</span></div>}
              {model.install.error && <p role="alert">{model.install.error}</p>}
              <div className="speech-output-actions">
                {!model.installed && !busy && <Button disabled={installing} onClick={() => void modelAction('download', model.id)}>{t('speech.download')}</Button>}
                {busy && <Button onClick={() => void modelAction('cancel')}>{t('speech.cancelDownload')}</Button>}
                {model.installed && <Button disabled={installing} onClick={() => setDeleteId(model.id)}>{t('speech.delete')}</Button>}
                {model.installed && draft.model_id !== model.id && <Button disabled={installing} onClick={() => set({ model_id: model.id, voice: model.voices[0].id, instructions: '' })}>{t('speech.selectModel')}</Button>}
                {model.id === draft.model_id && <span className="speech-output-selected">{t('tts.selected')}</span>}
              </div>
            </section>
          })}</div>
          </details>
          </>}
        </>}
        {(draft.mode === 'cloud' || draft.mode === 'remote') && <VoiceOutputConnection parametersOnly={parametersOnly} value={draft} providers={status.providers} onChange={set} />}
        <VoiceStyleSettings hideUnsupported={parametersOnly} value={draft.instructions} enabled={supportsInstructions} local={draft.mode === 'local'}
          required={draft.mode === 'local' && selected?.voice_design} onChange={instructions => set({ instructions })} />
        <div className="speech-output-row">
          <label>{t('digitalPerson.voiceRate')}<Input type="number" min={.5} max={2} step={.1} value={Number.isNaN(draft.rate) ? '' : draft.rate} onChange={e => set({ rate: e.target.valueAsNumber })} /></label>
          <label>{t('tts.volume')}<Input type="number" min={0} max={1} step={.1} value={Number.isNaN(draft.volume) ? '' : draft.volume} onChange={e => set({ volume: e.target.valueAsNumber })} /></label>
        </div>
        <label className="speech-output-check"><input type="checkbox" checked={profile.auto_speak ?? false} onChange={e => setProfile({ ...profile, auto_speak: e.target.checked })} />{t('digitalPerson.autoSpeak')}</label>
      </fieldset>
      <section className="speech-output-test">
        <label>{t('tts.testText')}<Textarea value={sample} rows={3} maxLength={1200} disabled={playing || disabled} onChange={e => setSample(e.target.value)} /></label>
        <div className="speech-output-actions"><Button aria-busy={playing} disabled={!playing && (!speechText(sample).trim() || saving || acting || disabled || !valid)} onClick={() => playing ? stop() : void test()}>{playing && <Spinner size={12} />}{t(playing ? 'digitalPerson.stopVoice' : 'tts.test')}</Button><span>{t('tts.draftTest')}</span></div>
      </section>
      <div className="speech-output-actions"><Button data-save-output variant="primary" loading={saving} disabled={!dirty || blocked || !valid} onClick={() => void save()}>{t('common.save')}</Button></div>
    </>}
    {error && <p role="alert" className="voice-input-error">{error}{!draft && <Button onClick={() => setRevision(v => v + 1)}>{t('common.retry')}</Button>}</p>}
    {notice && <p role="status">{notice}</p>}
    <ConfirmDialog open={!!deleteId} title={t('speech.delete')} message={t('tts.deleteConfirm')} onCancel={() => setDeleteId(null)} onConfirm={() => { const id = deleteId; setDeleteId(null); if (id) void modelAction('delete', id) }} />
  </section>
}
