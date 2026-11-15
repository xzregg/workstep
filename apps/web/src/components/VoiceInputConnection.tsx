import { useEffect, useState } from 'react'
import { defaultSpeechConnection, speechApi, speechConnectionReady, type SpeechConnection, type SpeechStatus } from '../api/speech'
import { useI18n } from '../i18n'
import Button from './Button'
import Input from './Input'
import Select from './Select'
import RadioCardGroup from './RadioCardGroup'

export default function VoiceInputConnection({ status, disabled, onSaved, onDirtyChange, onModeChange }: {
  status: SpeechStatus; disabled: boolean; onSaved: (status: SpeechStatus) => void
  onDirtyChange: (dirty: boolean) => void; onModeChange: (mode: SpeechConnection['mode']) => void
}) {
  const { t } = useI18n()
  const [saved, setSaved] = useState<SpeechConnection>({ ...defaultSpeechConnection, ...status.connection })
  const [draft, setDraft] = useState(saved), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  useEffect(() => { onDirtyChange(dirty || saving) }, [dirty, saving, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(() => { onModeChange(draft.mode) }, [draft.mode, onModeChange])
  const set = (patch: Partial<SpeechConnection>) => { setDraft(value => ({ ...value, ...patch })); setError('') }
  const choose = (mode: SpeechConnection['mode'], provider: SpeechConnection['provider']) => set({
    mode, provider, base_url: provider === 'openai' ? mode === 'remote' ? 'http://127.0.0.1:8000/v1' : 'https://api.openai.com/v1' : '',
    model: provider === 'openai' ? mode === 'remote' ? 'whisper-1' : 'gpt-transcribe' : provider === 'volcengine' ? 'bigmodel' : '16k_zh',
    app_id: '', api_key: null, secret_id: null, secret_key: null, has_api_key: false, has_secret_id: false, has_secret_key: false,
  })
  const save = async () => {
    setSaving(true); setError('')
    try {
      const { has_api_key: _a, has_secret_id: _b, has_secret_key: _c, ...value } = draft
      const result = await speechApi.configure(status.enabled, status.language, status.model_id, value)
      if (!result.connection || !result.models) throw new Error(t('asr.backendUpdateRequired'))
      const connection = { ...defaultSpeechConnection, ...result.connection }
      setSaved(connection); setDraft(connection); onSaved(result)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }
  return <section className="speech-input-connection">
    <fieldset disabled={disabled || saving}>
      <RadioCardGroup label={t('asr.mode')} value={draft.mode} disabled={disabled || saving}
        options={(['local', 'cloud', 'remote'] as const).map(mode => ({ value: mode, label: t(`asr.mode_${mode}`), description: t(`speechModes.${mode}`) }))}
        onChange={value => { const mode = value as SpeechConnection['mode']; choose(mode, mode === 'remote' ? 'openai' : 'tencent') }} />
      {draft.mode === 'cloud' && <label>{t('tts.provider')}<Select value={draft.provider} onChange={e => choose('cloud', e.target.value as SpeechConnection['provider'])}>
        <option value="tencent">{t('asr.tencent')}</option><option value="volcengine">{t('asr.volcengine')}</option><option value="openai">OpenAI compatible</option>
      </Select></label>}
      {draft.mode !== 'local' && <>
        {draft.mode === 'remote' && <p>{t('asr.remoteProtocol')}</p>}
        {draft.provider === 'openai' && <label>{t('tts.baseUrl')}<Input value={draft.base_url} onChange={e => set({ base_url: e.target.value })} /></label>}
        {draft.provider === 'tencent' ? <>
          <label>AppID<Input value={draft.app_id} onChange={e => set({ app_id: e.target.value })} /></label>
          <label>SecretId<Input type="password" autoComplete="off" value={draft.secret_id ?? ''} placeholder={draft.has_secret_id ? t('tts.secretSaved') : ''} onChange={e => set({ secret_id: e.target.value })} /></label>
          <label>SecretKey<Input type="password" autoComplete="new-password" value={draft.secret_key ?? ''} placeholder={draft.has_secret_key ? t('tts.secretSaved') : ''} onChange={e => set({ secret_key: e.target.value })} /></label>
        </> : <label>API Key<Input type="password" autoComplete="new-password" value={draft.api_key ?? ''} placeholder={draft.has_api_key ? t('tts.secretSaved') : draft.mode === 'remote' ? t('tts.optionalKey') : ''} onChange={e => set({ api_key: e.target.value })} /></label>}
        {draft.provider === 'volcengine' ? <label>{t('tts.resourceId')}<Input value={draft.resource_id} onChange={e => set({ resource_id: e.target.value })} /></label> :
          <label>{t('tts.model')}<Input value={draft.model} list={draft.provider === 'tencent' ? 'speech-tencent-engines' : undefined} onChange={e => set({ model: e.target.value })} /></label>}
        <datalist id="speech-tencent-engines"><option value="16k_zh"/><option value="16k_zh_en"/><option value="16k_yue"/><option value="16k_en"/></datalist>
        <p>{t(draft.provider === 'openai' ? 'asr.finalOnly' : 'asr.realtime')}</p>
      </>}
      {dirty && <div className="speech-model-actions"><Button data-save-input variant="primary" loading={saving} disabled={!speechConnectionReady(draft)} onClick={() => void save()}>{t('common.save')}</Button>
        <Button onClick={() => { setDraft(saved); setError('') }}>{t('common.cancel')}</Button><span>{t('asr.saveBeforeTest')}</span></div>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </section>
}
