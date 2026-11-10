import { useEffect, useRef, useState } from 'react'
import { speechApi, type SpeechStatus } from '../api/speech'
import { useI18n } from '../i18n'
import { useVoiceInput } from '../hooks/useVoiceInput'
import VoiceInputControls from '../components/VoiceInputControls'
import Button from '../components/Button'
import ConfirmDialog from '../components/ConfirmDialog'

const busyStages = ['resolving', 'downloading', 'installing']
const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`
export default function VoiceInputSettings() {
  const { t } = useI18n()
  const [status, setStatus] = useState<SpeechStatus | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [sample, setSample] = useState<string | null>(null)
  const alive = useRef(true)
  const voice = useVoiceInput({ ownerKey: 'speech-settings-test', disabled: !status?.enabled || !status.models.find(model => model.id === status.model_id)?.installed,
    compact: false, value: '', cursor: 0, onInsert: setSample })
  const load = async () => {
    try { const result = await speechApi.status(); if (alive.current) { setStatus(result); setError('') } }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : t('speech.failed')) }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [])
  const installing = !!status?.models.some(model => busyStages.includes(model.install.stage))
  useEffect(() => {
    if (!installing) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => { await load(); if (!cancelled) timer = setTimeout(() => void poll(), 1000) }
    timer = setTimeout(() => void poll(), 1000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [installing])
  const mutate = async (operation: () => Promise<unknown>) => {
    setSaving(true); setError('')
    try { await operation(); await load() }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : t('speech.failed')) }
    finally { if (alive.current) setSaving(false) }
  }
  const model = status?.models.find(item => item.id === status.model_id)
  return <div className="speech-settings">
    <h1>{t('speech.title')}</h1>
    <p>{t('speech.hostHint')}</p>
    {error && <p role="alert" className="voice-input-error">{error}</p>}
    {saving && <span role="status"><span className="task-status-spinner" />{t('common.loading')}</span>}
    {!status ? error ? <Button onClick={() => void load()}>{t('speech.retry')}</Button>
      : <span role="status"><span className="task-status-spinner" />{t('common.loading')}</span> : <>
      <label><input type="checkbox" checked={status.enabled} disabled={saving || voice.active || installing}
        onChange={e => void mutate(() => speechApi.configure(e.target.checked, status.language))} />{t('speech.enable')}</label>
      <label>{t('speech.language')}<select value={status.language} disabled={saving || voice.active || installing}
        onChange={e => void mutate(() => speechApi.configure(status.enabled, e.target.value))}>
        {status.languages.map(language => <option key={language} value={language}>{t(`speech.lang_${language}` as Parameters<typeof t>[0])}</option>)}
      </select></label>
      <p>{t('speech.service')}: {t(`speech.service_${status.service}`)}</p>
      <h2>{t('speech.models')}</h2>
      {status.models.map(model => {
        const stage = model.install.stage
        const rowInstalling = busyStages.includes(stage)
        const blocked = saving || voice.active || status.service === 'busy'
        return <div className="speech-model" key={model.id} data-current={model.id === status.model_id || undefined}>
        <div className="speech-model-heading"><strong>{model.name}</strong><span>{model.installed ? t(model.id === status.model_id ? 'speech.currentModel' : 'speech.installedModel') : mib(model.model_bytes)}</span></div>
        <p>{t(model.id === 'streaming-zipformer-zh-en-int8' ? 'speech.zipformerHint' : 'speech.modelHint')}</p><p><a href={model.license_url} target="_blank" rel="noreferrer">{model.license}</a></p>
        {rowInstalling && <>
          <span className="task-status-spinner" aria-hidden="true" /><span role="status">{t(`speech.stage_${stage}` as Parameters<typeof t>[0])}</span>
          <progress max={model.install.total_bytes || 1} value={model.install.total_bytes ? model.install.downloaded_bytes : undefined} />
          <span>{mib(model.install.downloaded_bytes)}{model.install.total_bytes ? ` / ${mib(model.install.total_bytes)}` : ''}</span>
        </>}
        {model.install.error && <p role="alert" className="voice-input-error">{model.install.error}</p>}
        <div className="speech-model-actions">
          {!model.installed && !rowInstalling && <Button disabled={blocked || installing} onClick={() => void mutate(() => speechApi.download(model.id))}>{t(stage === 'error' ? 'speech.retry' : 'speech.download')}</Button>}
          {model.installed && model.punctuation === false && !rowInstalling && <Button disabled={saving || voice.active || installing || status.service === 'busy'} onClick={() => void mutate(() => speechApi.download(model.id))}>{t('speech.downloadPunctuation')}</Button>}
          {rowInstalling && <Button disabled={saving} onClick={() => void mutate(speechApi.cancelDownload)}>{t('speech.cancelDownload')}</Button>}
          {model.installed && <Button disabled={saving || voice.active || installing || status.service === 'busy'} onClick={() => setConfirmDelete(model.id)}>{t('speech.delete')}</Button>}
          {model.installed && model.id !== status.model_id && <Button disabled={blocked || installing}
            onClick={() => { setSample(null); void mutate(() => speechApi.configure(status.enabled, status.language, model.id)) }}>{t('speech.selectModel')}</Button>}
        </div>
      </div>})}
      <Button disabled={saving || installing || !status.enabled || !model?.installed || voice.active}
        onClick={() => { setSample(null); void voice.start() }}>{t('speech.test')}</Button>
      <VoiceInputControls voice={voice} variant="test" />
      {sample !== null && <section className="speech-test-result" role="status">
        <strong>{t('speech.testComplete')}</strong>
        <p>{sample || t('speech.testNoSpeech')}</p>
      </section>}
    </>}
    <ConfirmDialog open={confirmDelete !== null} title={`${t('speech.delete')} · ${status?.models.find(item => item.id === confirmDelete)?.name ?? ''}`} message={t('speech.deleteConfirm')}
      onCancel={() => setConfirmDelete(null)} onConfirm={() => { const id = confirmDelete; setConfirmDelete(null); if (id) void mutate(() => speechApi.deleteModel(id)) }} />
  </div>
}
