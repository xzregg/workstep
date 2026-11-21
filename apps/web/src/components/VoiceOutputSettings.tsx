import { useEffect, useId, useRef, useState } from 'react'
import { digitalPersonApi, type DigitalPersonProfile } from '../api/digitalPerson'
import { OUTPUT_CHANGED, outputConfigured, outputLimits, outputValueInRange, speechOutputApi, type OutputSettings, type OutputStatus } from '../api/speechOutput'
import { SpeechOutputPlayer, speechText, takeSpeechSentences } from '../utils/speechOutput'
import { useI18n, localizeErrorDisplay } from '../i18n'
import Button from './Button'
import Input from './Input'
import Select from './Select'
import VoiceModelMirror, { formatVoiceModelSize as modelSize, useVoiceModelMirror } from './VoiceModelMirror'
import VoiceModelDownloadActions, { VoiceModelSavedDownload } from './VoiceModelDownloadActions'
import { modelDownloading } from '../api/speechModelInstall'
import Textarea from './Textarea'
import Spinner from './Spinner'
import ConfirmDialog from './ConfirmDialog'
import DigitalPersonVoice from './digital-person/DigitalPersonVoice'
import VoiceOutputConnection from './VoiceOutputConnection'
import VoiceStyleSettings from './VoiceStyleSettings'
import RadioCardGroup from './RadioCardGroup'
import { DIGITAL_PERSON_CHANGED } from './digital-person/useDigitalPerson'
import { speechDestinationKey } from '../api/speechCredentials'
import { useSpeechConnections } from '../hooks/useSpeechConnections'
import { useReferenceRecording } from '../hooks/useReferenceRecording'
import './VoiceOutputSettings.css'

const signature = (draft: OutputSettings | null, profile: DigitalPersonProfile | null) => JSON.stringify([
  draft, profile?.voice_name || '', profile?.expression || 'neutral', profile?.auto_speak ?? false,
])

export default function VoiceOutputSettings({ onDirtyChange, onBusyChange, initialProfile, onSaved, disabled = false, parametersOnly = false, active = true }: {
  onDirtyChange: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
  initialProfile?: DigitalPersonProfile
  onSaved?: (profile: DigitalPersonProfile) => void
  parametersOnly?: boolean
  disabled?: boolean
  active?: boolean
}) {
  const { t, locale } = useI18n()
  const mirror = useVoiceModelMirror('output')
  const [status, setStatus] = useState<OutputStatus | null>(null), [draft, setDraft] = useState<OutputSettings | null>(null)
  const connections = useSpeechConnections(status?.connections)
  const [profile, setProfile] = useState<DigitalPersonProfile | null>(null)
  const [saved, setSaved] = useState<{ settings: OutputSettings; profile: DigitalPersonProfile } | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [acting, setActing] = useState(false)
  const [previewPhase, setPreviewPhase] = useState<'preparing' | 'playing' | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [revision, setRevision] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<{ id: string; action: 'delete' | 'discard' | 'reference' } | null>(null)
  const [sample, setSample] = useState(t('tts.sample'))
  const [previewPrompt, setPreviewPrompt] = useState('')
  const [tonePrompts, setTonePrompts] = useState({ design: '', clone: '', preset: '' })
  const player = useRef<SpeechOutputPlayer | null>(null), alive = useRef(true)
  const referenceFile = useRef<HTMLInputElement>(null)
  const referenceHelpId = useId()
  const rangeHelpId = useId()
  const profileAtMount = useRef(initialProfile)
  useEffect(() => { onBusyChange?.(saving) }, [saving, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  const dirty = !!draft && !!saved && signature(draft, profile) !== signature(saved.settings, saved.profile)
  const installing = !!status?.models.some(model => modelDownloading(model.install))
  const playing = previewPhase !== null
  const blocked = saving || acting || playing || disabled
  const selected = status?.models.find(model => model.id === draft?.model_id)
  const supportsReference = selected?.voices.some(voice => voice.id === 'reference')
  const previewStyle = draft?.mode === 'local' ? selected?.style || undefined : undefined
  const adaptiveDelivery = !!previewStyle
  const cloning = draft?.voice === 'reference'
  const cloneAttributes = previewStyle === 'tone' && cloning && selected?.persona_runtime_missing === false && selected.design_attributes
  const designAttributes = cloneAttributes ? { pitch: cloneAttributes.pitch, style: cloneAttributes.style }
    : previewStyle === 'tone' && !cloning ? selected?.design_attributes : undefined
  const toneMode = cloneAttributes ? 'clone' : designAttributes ? 'design' : 'preset'
  const unavailableDesignGroups: ('accent' | 'dialect')[] = []
  if (toneMode === 'design') {
    const chineseSentence = /[\u3400-\u9fff]/
    const sentences = takeSpeechSentences(speechText(sample), true).sentences
    if (!sentences.length || sentences.some(text => chineseSentence.test(text))) unavailableDesignGroups.push('accent')
    if (!sentences.length || sentences.some(text => !chineseSentence.test(text))) unavailableDesignGroups.push('dialect')
  }
  const previewValue = previewStyle === 'tone' ? tonePrompts[toneMode].split(',').map(part => part.trim())
    .filter(part => part && !unavailableDesignGroups.some(group => designAttributes?.[group]?.[part])).join(', ') : previewPrompt
  const followsPersona = draft?.mode === 'local' && selected?.runtime === 'omnivoice' && draft.voice === 'persona'
  const runtimeMissing = followsPersona ? selected?.persona_runtime_missing : selected?.runtime_missing
  const usesReference = draft?.mode === 'local' && draft.voice === 'reference' && !!supportsReference
  const showReferenceText = selected?.runtime !== 'moss'
  const referenceControls = adaptiveDelivery || usesReference
  const deletingReference = pendingDelete?.action === 'reference'
  const deletingSavedVoice = deletingReference && saved?.settings.reference_id === pendingDelete.id &&
    saved.settings.mode === 'local' && saved.settings.voice === 'reference'
  const supportsInstructions = !!draft && (draft.mode === 'local' ? !!selected?.instructions :
    draft.mode === 'cloud' && draft.provider === 'qwen' && draft.model.includes('instruct') ||
    draft.mode === 'remote' && draft.provider === 'voicebox' && draft.engine === 'qwen_custom_voice' && draft.model.startsWith('1.7'))
  const valid = !!draft && outputConfigured(draft) && (draft.mode !== 'local' ||
    !!selected?.installed && !runtimeMissing && selected.voices.some(v => v.id === draft.voice)
    && (draft.voice !== 'reference' || !!draft.reference_id)
    && (!selected.voice_design || !!draft.instructions.trim()))

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
      setStatus(result); setDraft(settings); setProfile(value); setSaved({ settings, profile: value })
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
  const applyConnection = (next: OutputSettings) => {
    if (!draft) return
    setDraft({ ...next, model_id: draft.model_id, rate: draft.rate, volume: draft.volume,
      reference_id: draft.reference_id, reference_text: draft.reference_text })
    setNotice('')
  }
  const choose = (mode: OutputSettings['mode'], id?: string) => {
    if (!draft || !status) return
    connections.remember(draft)
    id ??= connections.recent(mode)?.provider ?? (mode === 'remote' ? 'voicebox' : 'qwen')
    const provider = status.providers.find(row => row.id === id)!
    applyConnection(connections.recent(mode, id) ?? {
      ...draft, mode, provider: id, model: provider.model, base_url: provider.base_url,
      voice: mode === 'local' ? (draft.model_id === 'kokoro-v1' ? '46' : selected?.voices[0]?.id || '0') : provider.voice,
      api_key: null, secret_id: null, secret_key: null, has_api_key: false, has_secret_id: false, has_secret_key: false,
      instructions: mode === 'local' && selected?.voice_design ? t('tts.eveningVoicePrompt') : '', region: id === 'tencent' ? 'ap-guangzhou' : 'beijing',
      app_id: '', resource_id: 'seed-tts-2.0', engine: 'qwen',
    })
  }
  const modelAction = async (action: Parameters<typeof speechOutputApi.modelAction>[0], id?: string) => {
    setActing(true); setError('')
    try { const result = await speechOutputApi.modelAction(action, id, action === 'download' ? mirror.mirror : undefined); if (alive.current) setStatus(result) }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (alive.current) setActing(false) }
  }
  const deleteReference = async (id: string) => {
    setActing(true); setError(''); setNotice('')
    try {
      const { settings } = await speechOutputApi.deleteReference(id)
      if (!alive.current) return
      const clearReference = (value: OutputSettings): OutputSettings => {
        if (value.reference_id !== id) return value
        const fallback = status?.models.find(model => model.id === value.model_id)?.voices[0]?.id
        return { ...value, reference_id: '', reference_text: '',
          ...(value.mode === 'local' && value.voice === 'reference' && { voice: fallback ?? settings.voice, instructions: '' }) }
      }
      setDraft(value => value && clearReference(value))
      setSaved(value => value && ({ ...value, settings: clearReference(value.settings) }))
      setStatus(value => value && ({ ...value, settings, references: value.references?.filter(item => item.id !== id) }))
      window.dispatchEvent(new Event(OUTPUT_CHANGED))
      setNotice(t('tts.referenceDeleted'))
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (alive.current) setActing(false) }
  }
  const uploadReference = async (file: File) => {
    setActing(true); setError('')
    try {
      if (!file.size || file.size > 12 * 1024 * 1024) throw new Error(t('tts.referenceHelp'))
      const result = await speechOutputApi.uploadReference(file)
      if (alive.current) {
        const reference = result.reference
        if (reference) setStatus(current => current && ({ ...current, references: [reference, ...(current.references ?? []).filter(item => item.id !== reference.id)] }))
        set({ voice: 'reference', reference_id: result.id, ...(result.id !== draft?.reference_id && { reference_text: '' }) })
      }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (alive.current) setActing(false) }
  }
  const recording = useReferenceRecording(active && !disabled && referenceControls ? selected?.id : undefined, uploadReference,
    message => setError(message === 'tts.referenceRecordingShort' ? t(message) : message))
  const recordingActive = recording.phase !== 'idle'
  const selectLocalModel = (model: OutputStatus['models'][number]) => {
    setPreviewError('')
    const keepReference = draft?.voice === 'reference' && draft.reference_id && model.voices.some(voice => voice.id === 'reference')
    set({ model_id: model.id, voice: keepReference ? 'reference' : model.voices[0].id, instructions: model.voice_design ? t('tts.eveningVoicePrompt') : '' })
  }
  const save = async () => {
    if (!draft || !profile) return
    setSaving(true); setError(''); setNotice('')
    try {
      const current = await digitalPersonApi.get()
      const result = await speechOutputApi.save(adaptiveDelivery ? { ...draft, instructions: '' } : draft)
      if (alive.current && (result.mode === 'cloud' || result.mode === 'remote')) {
        connections.remember(result)
        setStatus(current => current && ({ ...current, connections: [result,
          ...(current.connections ?? []).filter(row => speechDestinationKey(row) !== speechDestinationKey(result))] }))
      }
      const nextProfile = { ...current, voice_name: profile.voice_name, voice_rate: draft.rate, expression: profile.expression, auto_speak: profile.auto_speak }
      await digitalPersonApi.save(nextProfile)
      if (!alive.current) return
      setDraft(result); setProfile(nextProfile); setSaved({ settings: result, profile: nextProfile }); setNotice(t('tts.saved'))
      onSaved?.(nextProfile)
      window.dispatchEvent(new Event(DIGITAL_PERSON_CHANGED))
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (alive.current) setSaving(false) }
  }
  const stop = () => { player.current?.stop(); player.current = null; setPreviewPhase(null) }
  const editPreviewPrompt = (value: string) => {
    if (previewStyle === 'tone') setTonePrompts(current => ({ ...current, [toneMode]: value }))
    else setPreviewPrompt(value)
    setPreviewError('')
  }
  const test = async () => {
    if (!draft || !profile) return
    stop(); setError(''); setNotice(''); setPreviewError('')
    const sentences = takeSpeechSentences(speechText(sample), true).sentences
    if (!sentences.length) { setPreviewError(t('tts.previewNeedsText')); return }
    const current = (): boolean => alive.current && player.current === next
    const next = new SpeechOutputPlayer({ settings: adaptiveDelivery ? { ...draft, instructions: '' } : draft, preview: true, systemVoice: profile.voice_name,
      previewPrompt: previewStyle ? cloneAttributes && previewValue ? `attributes:${previewValue}` : previewValue.trim() : undefined,
      onPlayback: active => { if (active && current()) setPreviewPhase('playing') },
      onState: active => { if (!active && current()) setPreviewPhase(null) },
      onError: reason => { if (current()) setPreviewError(reason.message) } })
    player.current = next
    setPreviewPhase('preparing')
    try { await next.unlock(); if (current()) next.enqueue(sentences) }
    catch (reason) {
      if (!current()) return
      stop()
      setPreviewError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return <section className="speech-output-settings" aria-label={t('speech.tab_output')}>
    {loading ? <span role="status"><Spinner />{t('common.loading')}</span> : draft && profile && status && <>
      <fieldset disabled={blocked}>
        {!parametersOnly && <RadioCardGroup label={t('tts.mode')} value={draft.mode} disabled={blocked}
          options={(['system', 'local', 'cloud', 'remote'] as const).map(mode => ({ value: mode, label: t(`tts.mode_${mode}`), description: t(`speechModes.${mode}`) }))}
          onChange={value => choose(value as OutputSettings['mode'])} />}
        {draft.mode === 'system' && <DigitalPersonVoice preview={false} profile={{ ...profile, voice_rate: draft.rate }} onChange={patch => setProfile({ ...profile, ...patch })} />}
        {draft.mode === 'local' && <>
          {!parametersOnly && (
          <details className="speech-output-model-manager" open={!selected?.installed || (followsPersona && runtimeMissing) || installing || status.models.some(model => (model.install.partial_bytes ?? 0) > 0)}>
          <summary>{t('tts.manageModels')}</summary>
          <p className="speech-output-hint">{t('tts.localHint')}</p>
          <VoiceModelMirror settings={mirror} disabled={installing || acting} />
          {installing && <p>{t('voiceModel.background')}</p>}
          <div className="speech-output-models">{status.models.map(model => {
            const busy = modelDownloading(model.install)
            return <section className="speech-output-model" key={model.id} data-current={draft.model_id === model.id || undefined}>
              <div className="speech-output-model-heading"><strong>{model.name}</strong><span>{t('voiceModel.size', { size: modelSize(model.model_bytes) })}</span></div>
              <div className="speech-output-model-meta"><span>{model.installed ? t('speech.installedModel') : t('tts.notInstalled')}</span><span>{t('tts.sentence')}</span><a href={model.license_url} target="_blank" rel="noreferrer">{t('tts.source')}</a></div>
              {model.requirements && <p className="speech-output-hint">{model.requirements}</p>}
              {model.availability_error && <p className="speech-output-hint">{localizeErrorDisplay(model.availability_error)}</p>}
              {busy && <div className="speech-output-progress" role="status"><Spinner /><span>{model.runtime === 'qwen' && model.install.stage === 'installing' ? t('tts.installingRuntime') : t(`speech.stage_${model.install.stage}` as never)}</span><progress max={model.install.total_bytes || 1} value={model.install.total_bytes ? model.install.downloaded_bytes : undefined} /><span>{modelSize(model.install.downloaded_bytes)}{model.install.total_bytes ? ` / ${modelSize(model.install.total_bytes)}` : ''}</span></div>}
              {model.install.error && <p role="alert">{localizeErrorDisplay(model.install.error)}</p>}
              <VoiceModelSavedDownload install={model.install} />
              <div className="speech-output-actions">
                <VoiceModelDownloadActions install={model.install} disabled={acting} startDisabled={installing || !mirror.valid || !!model.availability_error}
                  downloadLabel={!model.installed ? t('speech.download') : model.persona_runtime_missing ? t('tts.omniInstallPersonaRuntime') : undefined}
                  onDownload={() => void modelAction('download', model.id)}
                  onPause={() => void modelAction('cancel')}
                  onDiscard={() => setPendingDelete({ id: model.id, action: 'discard' })} />
                {model.installed && <Button disabled={installing} onClick={() => setPendingDelete({ id: model.id, action: 'delete' })}>{t('speech.delete')}</Button>}
                {model.installed && draft.model_id !== model.id && <Button disabled={installing} onClick={() => selectLocalModel(model)}>{t('speech.selectModel')}</Button>}
                {model.id === draft.model_id && <span className="speech-output-selected">{t('tts.selected')}</span>}
              </div>
            </section>
          })}</div>
          </details>
          )}
          {(!parametersOnly || supportsReference) && <label>{t('tts.model')}<Select data-output-model value={draft.model_id} onChange={event => {
            const model = status.models.find(m => m.id === event.target.value)!
            selectLocalModel(model)
          }}>{status.models.map(model => <option key={model.id} value={model.id} disabled={!!model.availability_error}>{model.name}</option>)}</Select></label>}
          {!adaptiveDelivery && <label>{t('digitalPerson.voiceName')}<Select value={draft.voice} onChange={e => set({ voice: e.target.value })}>
            {selected?.voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select></label>}
          {referenceControls && selected && <>
            {(adaptiveDelivery || !!status.references?.length || !!draft.reference_id) && <div className="speech-output-reference-select">
            <label>{t(adaptiveDelivery ? 'tts.optionalReference' : 'tts.savedReferences')}
              <Select value={usesReference ? draft.reference_id || '' : ''} disabled={recordingActive} onChange={event => {
                const id = event.target.value
                if (id) set({ voice: 'reference', reference_id: id, ...(id !== draft.reference_id && { reference_text: '' }) })
                else set({ voice: selected.voices[0].id })
              }}>
                <option value="" disabled={!adaptiveDelivery}>{t(adaptiveDelivery ? 'tts.defaultWithoutReference' : 'tts.chooseSavedReference')}</option>
                {draft.reference_id && !status.references?.some(item => item.id === draft.reference_id) &&
                  <option value={draft.reference_id}>{t('tts.currentReference')}</option>}
                {status.references?.map(item => <option key={item.id} value={item.id}>
                  {new Date(item.modified * 1000).toLocaleString(locale)} · {t('tts.referenceDuration', { seconds: item.duration.toFixed(1) })}
                </option>)}
              </Select>
            </label>
            <Button aria-label={t('tts.deleteReference')} disabled={!usesReference || !draft.reference_id || recordingActive}
              onClick={() => draft.reference_id && setPendingDelete({ id: draft.reference_id, action: 'reference' })}>{t('common.delete')}</Button>
            </div>}
            <input ref={referenceFile} type="file" accept=".wav,audio/wav" hidden
              aria-label={t('tts.referenceAudio')} onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file && !recordingActive) void uploadReference(file)
            }} />
            <div className="speech-output-reference">
              <div className="speech-output-actions">
                {recording.phase === 'idle' ? <>
                  <Button onClick={() => referenceFile.current?.click()}>{t(usesReference && draft.reference_id ? 'tts.replaceReference' : 'tts.referenceAudio')}</Button>
                  <Button onClick={() => void recording.start()}>{t('tts.recordReference')}</Button>
                </> : <>
                  <div className="speech-output-recording-actions">
                    {recording.phase === 'recording' && <Button variant="primary" onClick={() => void recording.finish()}>{t('tts.useRecording')}</Button>}
                    {recording.phase !== 'finishing' && <Button onClick={recording.cancel}>{t('common.cancel')}</Button>}
                  </div>
                  <span role="status">{recording.phase !== 'recording' && <Spinner size={12} />}
                    {t(recording.phase === 'requesting' ? 'tts.recordingRequesting'
                      : recording.phase === 'recording' ? 'tts.recordingActive' : 'tts.recordingFinishing')}</span>
                </>}
              </div>
              <p className="speech-output-hint">{usesReference && draft.reference_id ? t('tts.referenceReady') : t('tts.referenceHelp')}</p>
              <div className="speech-output-reference-example">
                <strong>{t('tts.referenceReadingLabel')}</strong>
                <p>{t('tts.referenceReadingExample')}</p>
              </div>
            </div>
            {usesReference && showReferenceText && <div className="speech-output-reference">
              <label>{t('tts.referenceText')}<Textarea rows={2} aria-describedby={referenceHelpId}
                placeholder={t('tts.referenceTranscriptPlaceholder')} maxLength={500} value={draft.reference_text ?? ''}
                onChange={event => set({ reference_text: event.target.value })} /></label>
              <div className="speech-output-actions">
                <span id={referenceHelpId}>{t('tts.referenceTranscriptHelp')}</span>
                <Button size="sm" disabled={!draft.reference_id || recordingActive}
                  onClick={() => set({ reference_text: t('tts.referenceReadingExample') })}>{t('tts.useReferenceExample')}</Button>
              </div>
            </div>}
            {selected.runtime === 'cosyvoice3' && usesReference && previewPrompt.trim() && <p className="speech-output-hint">{t('tts.referenceStyleHint')}</p>}
          </>}
          {runtimeMissing && !selected?.availability_error && <p className="speech-output-hint">{t(followsPersona ? 'tts.omniPersonaRuntimeMissing' : 'tts.runtimeMissing')}</p>}
          {selected?.voice_design && <p className="speech-output-hint">{t('tts.voiceDesignHint')}</p>}
          {!parametersOnly && <div className="speech-output-actions"><span>{t('speech.service')}: {t(`speech.service_${status.service}`)}</span><Button disabled={status.service !== 'ready'} onClick={() => void modelAction('unload')}>{t('tts.unload')}</Button></div>}
        </>}
        {(draft.mode === 'cloud' || draft.mode === 'remote') && <VoiceOutputConnection parametersOnly={parametersOnly} value={draft} providers={status.providers}
          addresses={connections.addresses(draft)} onProviderChange={id => choose(draft.mode, id)}
          onDestinationChange={patch => applyConnection(connections.editDestination(draft, { ...draft, ...patch }))} onChange={set} />}
        {!adaptiveDelivery && <VoiceStyleSettings hideUnsupported={parametersOnly || (draft.mode === 'local' && selected?.runtime === 'moss')} value={draft.instructions}
            enabled={supportsInstructions} local={draft.mode === 'local'} required={draft.mode === 'local' && selected?.voice_design}
            onChange={instructions => set({ instructions })} />}
        <div className="speech-output-row">
          {(['rate', 'volume'] as const).map(field => {
            const { min, max } = outputLimits[field]
            const invalid = !outputValueInRange(draft[field], outputLimits[field])
            const helpId = `${rangeHelpId}-${field}`
            const labelId = `${helpId}-label`
            return <label key={field}>
              <span className="speech-output-range-heading">
                <span id={labelId}>{t(field === 'rate' ? 'digitalPerson.voiceRate' : 'tts.volume')}</span>
                <span id={helpId} className={invalid ? 'speech-output-range-error' : 'speech-output-hint'}>
                  {t(field === 'rate' ? 'tts.rateRange' : 'tts.volumeRange', { min, max })}
                </span>
              </span>
              <Input type="number" min={min} max={max} step={.1} aria-invalid={invalid || undefined}
                aria-labelledby={labelId} aria-describedby={helpId}
                value={Number.isNaN(draft[field]) ? '' : draft[field]} onChange={e => set({ [field]: e.target.valueAsNumber })} />
            </label>
          })}
        </div>
        <label className="speech-output-check"><input type="checkbox" checked={profile.auto_speak ?? false} onChange={e => setProfile({ ...profile, auto_speak: e.target.checked })} />{t('digitalPerson.autoSpeak')}</label>
      </fieldset>
      <section className="speech-output-test">
        {adaptiveDelivery && <p className="speech-output-hint">{t(previewStyle === 'tone' ? 'tts.omniDigitalDeliveryHelp' : 'tts.digitalDeliveryHelp')}</p>}
        {previewStyle && <fieldset disabled={blocked}>
          <VoiceStyleSettings value={previewValue} onChange={editPreviewPrompt} style={previewStyle} designAttributes={designAttributes}
            unavailableDesignGroups={unavailableDesignGroups} cloning={cloning} pacePresets={selected?.runtime === 'cosyvoice3'} enabled local preview />
        </fieldset>}
        <label>{t('tts.testText')}<Textarea value={sample} rows={3} maxLength={1200} disabled={playing || disabled} onChange={e => { setSample(e.target.value); setPreviewError('') }} /></label>
        <div className="speech-output-actions"><Button aria-busy={playing} disabled={!playing && (!speechText(sample).trim() || saving || acting || disabled || recordingActive || !valid)} onClick={() => playing ? stop() : void test()}>{previewPhase === 'preparing' && <Spinner size={12} />}{t(playing ? 'digitalPerson.stopVoice' : 'tts.test')}</Button>
          <span role="status">{t(previewPhase === 'preparing' ? 'tts.previewPreparing' : previewPhase === 'playing' ? 'tts.previewPlaying' : 'tts.draftTest')}</span>
        </div>
        {previewError && <p role="alert" className="voice-input-error">{localizeErrorDisplay(previewError)}</p>}
      </section>
      <div className="speech-output-actions"><Button data-save-output variant="primary" loading={saving} disabled={!dirty || blocked || recordingActive || !valid} onClick={() => void save()}>{t('common.save')}</Button></div>
    </>}
    {error && <p role="alert" className="voice-input-error">{localizeErrorDisplay(error)}{!draft && <Button onClick={() => setRevision(v => v + 1)}>{t('common.retry')}</Button>}</p>}
    {notice && <p role="status">{notice}</p>}
    <ConfirmDialog open={!!pendingDelete} title={deletingReference ? t('tts.deleteReference') : `${t(pendingDelete?.action === 'discard' ? 'voiceModel.discard' : 'speech.delete')} · ${status?.models.find(model => model.id === pendingDelete?.id)?.name ?? ''}`}
      message={t(deletingReference ? deletingSavedVoice ? 'tts.deleteActiveReferenceConfirm' : 'tts.deleteReferenceConfirm'
        : pendingDelete?.action === 'discard' ? 'voiceModel.discardConfirm' : 'tts.deleteConfirm')}
      confirmText={deletingReference ? t('common.delete') : pendingDelete?.action === 'discard' ? t('voiceModel.discard') : undefined}
      danger={deletingReference || pendingDelete?.action === 'discard'}
      onCancel={() => setPendingDelete(null)} onConfirm={() => {
        setPendingDelete(null)
        if (pendingDelete?.action === 'reference') void deleteReference(pendingDelete.id)
        else if (pendingDelete) void modelAction(pendingDelete.action, pendingDelete.id)
      }} />
  </section>
}
