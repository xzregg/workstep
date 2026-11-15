import { useEffect, useRef, useState } from 'react'
import { speechOutputApi, type OutputSettings, type OutputStatus } from '../api/speechOutput'
import { useI18n } from '../i18n'
import Input from './Input'
import Select from './Select'
import Button from './Button'

export default function VoiceOutputConnection({ value, providers, onChange, parametersOnly = false }: {
  parametersOnly?: boolean
  value: OutputSettings; providers: OutputStatus['providers']; onChange: (patch: Partial<OutputSettings>) => void
}) {
  const { t } = useI18n(), provider = providers.find(p => p.id === value.provider)
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    const invalidate = () => { generation.current++ }
    invalidate(); setVoices([]); setLoading(false); setError('')
    return invalidate
  }, [value.base_url, value.provider, value.api_key])
  const discover = async () => {
    const request = ++generation.current
    setLoading(true); setError('')
    try {
      const result = await speechOutputApi.voices(value)
      if (generation.current === request) { setVoices(result); if (!result.length) setError(t('tts.noVoices')) }
    }
    catch (reason) { if (generation.current === request) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (generation.current === request) setLoading(false) }
  }
  return <>
    {!parametersOnly && <>
    <label>{t('tts.provider')}<Select value={value.provider} onChange={event => {
      const p = providers.find(p => p.id === event.target.value)!
      onChange({ provider: p.id, model: p.model, voice: p.voice, base_url: p.base_url,
        api_key: null, secret_id: null, secret_key: null, has_api_key: false, has_secret_id: false, has_secret_key: false,
        instructions: '', region: p.id === 'tencent' ? 'ap-guangzhou' : 'beijing' })
    }}>{providers.filter(p => value.mode === 'remote' ? ['voicebox', 'openai'].includes(p.id) : p.id !== 'voicebox').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
    {(value.mode === 'remote' || value.provider === 'openai') && <label>{t('tts.baseUrl')}<Input value={value.base_url} placeholder={provider?.base_url} onChange={e => onChange({ base_url: e.target.value })} /></label>}
    {value.provider === 'tencent' ? <>
      <label>SecretId<Input type="password" autoComplete="off" value={value.secret_id ?? ''} placeholder={value.has_secret_id ? t('tts.secretSaved') : ''} onChange={e => onChange({ secret_id: e.target.value })} /></label>
      <label>SecretKey<Input type="password" autoComplete="new-password" value={value.secret_key ?? ''} placeholder={value.has_secret_key ? t('tts.secretSaved') : ''} onChange={e => onChange({ secret_key: e.target.value })} /></label>
      <label>{t('tts.region')}<Input value={value.region} onChange={e => onChange({ region: e.target.value })} /></label>
    </> : <label>API Key<Input type="password" autoComplete="new-password" value={value.api_key ?? ''} placeholder={value.has_api_key ? t('tts.secretSaved') : t('tts.optionalKey')} onChange={e => onChange({ api_key: e.target.value })} /></label>}
    {value.provider === 'qwen' && <label>{t('tts.region')}<Select value={value.region} onChange={e => onChange({ region: e.target.value })}><option value="beijing">{t('tts.beijing')}</option><option value="singapore">{t('tts.singapore')}</option></Select></label>}
    {value.provider === 'volcengine' && <>
      <label>{t('tts.resourceId')}<Input value={value.resource_id} onChange={e => onChange({ resource_id: e.target.value })} /></label>
      <label>{t('tts.appId')}<Input value={value.app_id} onChange={e => onChange({ app_id: e.target.value })} /></label>
    </>}
    {!['tencent', 'volcengine'].includes(value.provider) && <label>{t('tts.model')}<Input list={value.provider === 'qwen' ? 'speech-qwen-models' : undefined} value={value.model} onChange={e => onChange({ model: e.target.value, instructions: '' })} /></label>}
    {value.provider === 'qwen' && <datalist id="speech-qwen-models"><option value="qwen3-tts-flash-realtime" /><option value="qwen3-tts-instruct-flash-realtime" /></datalist>}
    {value.provider === 'voicebox' && <label>{t('tts.engine')}<Select value={value.engine} onChange={e => onChange({ engine: e.target.value, instructions: '' })}><option value="qwen">Qwen Base</option><option value="qwen_custom_voice">Qwen CustomVoice</option><option value="kokoro">Kokoro</option></Select></label>}
    </>}
    <label>{t(value.provider === 'voicebox' ? 'tts.profileId' : 'digitalPerson.voiceName')}{voices.length ? <Select value={value.voice} onChange={e => onChange({ voice: e.target.value })}><option value="">{t('tts.chooseVoice')}</option>{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</Select> : <Input value={value.voice} onChange={e => onChange({ voice: e.target.value })} />}</label>
    {value.provider === 'voicebox' && <div className="speech-output-actions"><Button loading={loading} disabled={loading || !value.base_url.trim()} onClick={() => void discover()}>{t('tts.readVoices')}</Button>{error && <span role="alert">{error}</span>}</div>}
    {!parametersOnly && <p className="speech-output-hint">{t(provider?.streaming ? 'tts.streaming' : 'tts.sentence')}</p>}
  </>
}
