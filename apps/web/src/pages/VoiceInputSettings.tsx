import SettingsHelpButton from '../components/SettingsHelpButton'
import VoiceWakeSettings from '../components/digital-person/VoiceWakeSettings'
import type { WakeGreetingVoice } from '../audio/wakeGreeting'
import { useEffect, useRef, useState } from 'react'
import { speechApi, type SpeechStatus } from '../api/speech'
import { useI18n, localizeErrorDisplay } from '../i18n'
import { useVoiceInput } from '../hooks/useVoiceInput'
import VoiceInputControls from '../components/VoiceInputControls'
import Button from '../components/Button'
import Select from '../components/Select'
import ConfirmDialog from '../components/ConfirmDialog'
import VoiceOutputSettings from '../components/VoiceOutputSettings'
import VoiceInputConnection from '../components/VoiceInputConnection'
import VoiceprintSettings from '../components/VoiceprintSettings'
import VoiceModelMirror, { formatVoiceModelSize as modelSize, useVoiceModelMirror } from '../components/VoiceModelMirror'
import VoiceModelDownloadActions, { VoiceModelSavedDownload } from '../components/VoiceModelDownloadActions'
import { modelDownloading } from '../api/speechModelInstall'
import '../components/ProjectSharingTabs.css'
import '../components/SpeechSettings.css'

export default function VoiceInputSettings({ onDirtyChange, onBusyChange, sections = ['input', 'output'], wakeVoice }: {
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
  sections?: readonly ('input' | 'output' | 'wake')[]
  wakeVoice?: WakeGreetingVoice
} = {}) {
  const { t } = useI18n()
  const mirror = useVoiceModelMirror('input')
  const [tab, setTab] = useState<'input' | 'output' | 'wake'>('input')
  const [outputVisited, setOutputVisited] = useState(false)
  const [outputDirty, setOutputDirty] = useState(false)
  const [wakeDirty, setWakeDirty] = useState(false)
  const [inputDirty, setInputDirty] = useState(false), [inputMode, setInputMode] = useState<'local' | 'cloud' | 'remote'>('local')
  useEffect(() => { onDirtyChange?.(outputDirty || wakeDirty || inputDirty) }, [outputDirty, wakeDirty, inputDirty, onDirtyChange])
  const [status, setStatus] = useState<SpeechStatus | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [inputBusy, setInputBusy] = useState(false)
  const [wakeBusy, setWakeBusy] = useState(false)
  const [voiceprintBusy, setVoiceprintBusy] = useState(false)
  const busy = saving || inputBusy || wakeBusy || voiceprintBusy
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; partial?: boolean } | null>(null)
  const [sample, setSample] = useState<string | null>(null)
  const alive = useRef(true)
  const ready = status?.ready ?? !!status?.models.find(model => model.id === status.model_id)?.installed
  const voice = useVoiceInput({ ownerKey: 'speech-settings-test', disabled: !status?.enabled || !ready || inputDirty,
    compact: false, value: '', cursor: 0, onInsert: setSample })
  const load = async () => {
    try { const result = await speechApi.status(); if (alive.current) { setStatus(result); setError('') } }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : t('speech.failed')) }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [])
  const installing = !!status?.models.some(model => modelDownloading(model.install))
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
  return <div className="speech-settings">
    <h1>{t('speech.settings')}<SettingsHelpButton section="speech" /></h1>
    <div className="project-sharing-tabs" role="tablist" aria-label={t('speech.settings')}>
      {sections.map(value => <button type="button" role="tab" key={value}
        id={`speech-tab-${value}`} aria-controls={`speech-panel-${value}`} aria-selected={tab === value} disabled={busy}
        onClick={() => { setTab(value); if (value === 'output') setOutputVisited(true) }}>{t(`speech.tab_${value}`)}</button>)}
    </div>
    <div className="speech-settings-panel" role="tabpanel" id="speech-panel-input" aria-labelledby="speech-tab-input" hidden={tab !== 'input'}>
    {error && <p role="alert" className="voice-input-error">{localizeErrorDisplay(error)}</p>}
    {saving && <span role="status"><span className="task-status-spinner" />{t('common.loading')}</span>}
    {!status ? error ? <Button onClick={() => void load()}>{t('speech.retry')}</Button>
      : <span role="status"><span className="task-status-spinner" />{t('common.loading')}</span> : <>
      <label className="speech-setting-toggle"><input type="checkbox" checked={status.enabled} disabled={saving || voiceprintBusy || voice.active || installing || inputDirty}
        onChange={e => void mutate(() => speechApi.configure(e.target.checked, status.language))} />{t('speech.enable')}</label>
      <VoiceInputConnection status={status} disabled={saving || voiceprintBusy || voice.active || installing}
        onSaved={setStatus} onDirtyChange={setInputDirty} onModeChange={setInputMode} onBusyChange={setInputBusy} />
      <p>{t(inputMode === 'local' ? 'speech.hostHint' : 'asr.remoteHint')}</p>
      <label>{t('speech.language')}<Select value={status.language} disabled={saving || voiceprintBusy || voice.active || installing}
        onChange={e => void mutate(() => speechApi.configure(status.enabled, e.target.value))}>
        {status.languages.map(language => <option key={language} value={language}>{t(`speech.lang_${language}` as Parameters<typeof t>[0])}</option>)}
      </Select></label>
      <p>{t('speech.service')}: {t(`speech.service_${status.service}`)}</p>
      {inputMode === 'local' && <><h2>{t('speech.models')}</h2>
      <VoiceModelMirror settings={mirror} disabled={installing || saving || voiceprintBusy} />
      {installing && <p>{t('voiceModel.background')}</p>}
      <div className="speech-models">{status.models.map(model => {
        const stage = model.install.stage
        const rowInstalling = modelDownloading(model.install)
        const blocked = saving || voiceprintBusy || voice.active || status.service === 'busy'
        return <div className="speech-model" key={model.id} data-current={model.id === status.model_id || undefined}>
        <div className="speech-model-heading"><strong>{model.name}</strong><span>{t('voiceModel.size', { size: modelSize(model.model_bytes) })}</span></div>
        {model.installed && <p>{t(model.id === status.model_id ? 'speech.currentModel' : 'speech.installedModel')}</p>}
        <p>{t(model.streaming === 'segment' ? 'speech.senseVoiceHint' : 'speech.modelHint')}</p><p><a href={model.license_url} target="_blank" rel="noreferrer">{model.license}</a></p>
        {rowInstalling && <>
          <span className="task-status-spinner" aria-hidden="true" /><span role="status">{t(`speech.stage_${stage}` as Parameters<typeof t>[0])}</span>
          <progress max={model.install.total_bytes || 1} value={model.install.total_bytes ? model.install.downloaded_bytes : undefined} />
          <span>{modelSize(model.install.downloaded_bytes)}{model.install.total_bytes ? ` / ${modelSize(model.install.total_bytes)}` : ''}</span>
        </>}
        {model.install.error && <p role="alert" className="voice-input-error">{localizeErrorDisplay(model.install.error)}</p>}
        <VoiceModelSavedDownload install={model.install} />
        <div className="speech-model-actions">
          <VoiceModelDownloadActions install={model.install} disabled={saving} startDisabled={blocked || installing || !mirror.valid}
            downloadLabel={!model.installed ? t(stage === 'error' ? 'speech.retry' : 'speech.download')
              : model.punctuation === false ? t('speech.downloadPunctuation') : undefined}
            onDownload={() => void mutate(() => speechApi.download(model.id, mirror.mirror))}
            onPause={() => void mutate(speechApi.cancelDownload)}
            onDiscard={() => setConfirmDelete({ id: model.id, partial: true })} />
          {model.installed && <Button disabled={blocked || installing} onClick={() => setConfirmDelete({ id: model.id })}>{t('speech.delete')}</Button>}
          {model.installed && model.id !== status.model_id && <Button disabled={blocked || installing}
            onClick={() => { setSample(null); void mutate(() => speechApi.configure(status.enabled, status.language, model.id)) }}>{t('speech.selectModel')}</Button>}
        </div>
      </div>})}</div></>}
      {status.voiceprint && inputMode === 'local' && <VoiceprintSettings key={JSON.stringify(status.voiceprint)} initialStatus={status.voiceprint}
        disabled={saving || voice.active || installing || inputDirty || status.service === 'busy'}
        mirror={mirror.valid ? mirror.mirror ?? 'https://huggingface.co' : undefined} onBusyChange={setVoiceprintBusy} />}
      <Button disabled={saving || voiceprintBusy || installing || !status.enabled || !ready || voice.active || inputDirty}
        onClick={() => { setSample(null); void voice.start() }}>{t('speech.test')}</Button>
      <VoiceInputControls voice={voice} variant="test" />
      {sample !== null && <section className="speech-test-result" role="status">
        <strong>{t('speech.testComplete')}</strong>
        <p>{sample || t('speech.testNoSpeech')}</p>
      </section>}
    </>}
    </div>
    {sections.includes('output') && <div className="speech-settings-panel" role="tabpanel" id="speech-panel-output" aria-labelledby="speech-tab-output" hidden={tab !== 'output'}>
      {outputVisited && <VoiceOutputSettings active={tab === 'output'} onDirtyChange={setOutputDirty} />}
    </div>}
    {sections.includes('wake') && <div className="speech-settings-panel" role="tabpanel" id="speech-panel-wake" aria-labelledby="speech-tab-wake" hidden={tab !== 'wake'}>
      <VoiceWakeSettings onDirtyChange={setWakeDirty} onBusyChange={setWakeBusy} active={tab === 'wake'} microphoneBusy={voice.active} voice={wakeVoice} />
    </div>}
    <ConfirmDialog open={confirmDelete !== null} title={`${t(confirmDelete?.partial ? 'voiceModel.discard' : 'speech.delete')} · ${status?.models.find(item => item.id === confirmDelete?.id)?.name ?? ''}`}
      message={t(confirmDelete?.partial ? 'voiceModel.discardConfirm' : 'speech.deleteConfirm')}
      confirmText={confirmDelete?.partial ? t('voiceModel.discard') : undefined} danger={confirmDelete?.partial}
      onCancel={() => setConfirmDelete(null)} onConfirm={() => {
        setConfirmDelete(null)
        if (confirmDelete) void mutate(() => confirmDelete.partial ? speechApi.deleteModel(confirmDelete.id, true) : speechApi.deleteModel(confirmDelete.id))
      }} />
  </div>
}
