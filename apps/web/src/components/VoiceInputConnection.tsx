import { useEffect, useState } from 'react'
import { defaultSpeechConnection, speechApi, speechConnectionReady, type SpeechConnection, type SpeechStatus } from '../api/speech'
import { useI18n, localizeErrorDisplay } from '../i18n'
import Button from './Button'
import Input from './Input'
import Select from './Select'
import RadioCardGroup from './RadioCardGroup'
import SpeechAddressField from './SpeechAddressField'
import SpeechSecretField from './SpeechSecretField'
import { speechDestinationKey, type SpeechSecret } from '../api/speechCredentials'
import { useSpeechConnections } from '../hooks/useSpeechConnections'

export default function VoiceInputConnection({ status, disabled, onSaved, onDirtyChange, onModeChange, onBusyChange }: {
  status: SpeechStatus; disabled: boolean; onSaved: (status: SpeechStatus) => void
  onDirtyChange: (dirty: boolean) => void; onModeChange: (mode: SpeechConnection['mode']) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const { t } = useI18n()
  const [saved, setSaved] = useState<SpeechConnection>({ ...defaultSpeechConnection, ...status.connection })
  const [draft, setDraft] = useState(saved), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const connections = useSpeechConnections(status.connections)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  useEffect(() => { onDirtyChange(dirty || saving) }, [dirty, saving, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(() => { onBusyChange?.(saving) }, [saving, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  useEffect(() => { onModeChange(draft.mode) }, [draft.mode, onModeChange])
  const set = (patch: Partial<SpeechConnection>) => { setDraft(value => ({ ...value, ...patch })); setError('') }
  const choose = (mode: SpeechConnection['mode'], provider?: SpeechConnection['provider']) => {
    connections.remember(draft)
    provider ??= connections.recent(mode)?.provider ?? (mode === 'remote' ? 'openai' : 'tencent')
    setDraft(connections.recent(mode, provider) ?? {
      ...defaultSpeechConnection, mode, provider,
      base_url: provider === 'openai' ? mode === 'remote' ? 'http://127.0.0.1:8000/v1' : 'https://api.openai.com/v1' : '',
      model: provider === 'openai' ? mode === 'remote' ? 'whisper-1' : 'gpt-transcribe' : provider === 'volcengine' ? 'bigmodel' : '16k_zh',
    })
    setError('')
  }
  const changeDestination = (patch: Partial<SpeechConnection>) => {
    setDraft(connections.editDestination(draft, { ...draft, ...patch }))
    setError('')
  }
  const secretField = (field: SpeechSecret, label: string, placeholder?: string) =>
    <SpeechSecretField key={`${speechDestinationKey(draft)}:${field}`} kind="speech" connection={draft} field={field}
      label={label} placeholder={placeholder} onChange={value => set({ [field]: value })} />
  const save = async () => {
    setSaving(true); setError('')
    try {
      const { has_api_key: _a, has_secret_id: _b, has_secret_key: _c, ...value } = draft
      const result = await speechApi.configure(status.enabled, status.language, status.model_id, value)
      if (!result.connection || !result.models) throw new Error(t('asr.backendUpdateRequired'))
      const connection = { ...defaultSpeechConnection, ...result.connection }
      connections.remember(connection)
      setSaved(connection); setDraft(connection); onSaved(result)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }
  return <section className="speech-input-connection">
    <fieldset disabled={disabled || saving}>
      <RadioCardGroup label={t('asr.mode')} value={draft.mode} disabled={disabled || saving}
        options={(['local', 'cloud', 'remote'] as const).map(mode => ({ value: mode, label: t(`asr.mode_${mode}`), description: t(`speechModes.${mode}`) }))}
        onChange={value => choose(value as SpeechConnection['mode'])} />
      {draft.mode === 'cloud' && <label>{t('tts.provider')}<Select value={draft.provider} onChange={e => choose('cloud', e.target.value as SpeechConnection['provider'])}>
        <option value="tencent">{t('asr.tencent')}</option><option value="volcengine">{t('asr.volcengine')}</option><option value="openai">OpenAI compatible</option>
      </Select></label>}
      {draft.mode !== 'local' && <>
        {draft.mode === 'remote' && <p>{t('asr.remoteProtocol')}</p>}
        {draft.provider === 'openai' && <SpeechAddressField value={draft.base_url} addresses={connections.addresses(draft)} onChange={base_url => changeDestination({ base_url })} />}
        {draft.provider === 'tencent' ? <>
          <label>AppID<Input value={draft.app_id} onChange={e => changeDestination({ app_id: e.target.value })} /></label>
          {secretField('secret_id', 'SecretId')}
          {secretField('secret_key', 'SecretKey')}
        </> : secretField('api_key', 'API Key', draft.mode === 'remote' ? t('tts.optionalKey') : undefined)}
        {draft.provider === 'volcengine' ? <label>{t('tts.resourceId')}<Input value={draft.resource_id} onChange={e => set({ resource_id: e.target.value })} /></label> :
          <label>{t('tts.model')}<Input value={draft.model} list={draft.provider === 'tencent' ? 'speech-tencent-engines' : undefined} onChange={e => set({ model: e.target.value })} /></label>}
        <datalist id="speech-tencent-engines"><option value="16k_zh"/><option value="16k_zh_en"/><option value="16k_yue"/><option value="16k_en"/></datalist>
        <p>{t(draft.provider === 'openai' ? 'asr.finalOnly' : 'asr.realtime')}</p>
      </>}
      {dirty && <div className="speech-model-actions"><Button data-save-input variant="primary" loading={saving} disabled={!speechConnectionReady(draft)} onClick={() => void save()}>{t('common.save')}</Button>
        <Button onClick={() => { connections.reset(); setDraft(saved); setError('') }}>{t('common.cancel')}</Button><span>{t('asr.saveBeforeTest')}</span></div>}
    </fieldset>
    {error && <p role="alert">{localizeErrorDisplay(error)}</p>}
  </section>
}
