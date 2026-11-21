import { useEffect, useRef, useState } from 'react'
import { speechOutputApi, type OutputSettings, type OutputStatus } from '../api/speechOutput'
import { useI18n, localizeErrorDisplay } from '../i18n'
import Input from './Input'
import Select from './Select'
import Button from './Button'
import SpeechAddressField from './SpeechAddressField'
import SpeechSecretField from './SpeechSecretField'
import { speechDestinationKey, type SpeechSecret } from '../api/speechCredentials'

export default function VoiceOutputConnection({ value, providers, addresses, onProviderChange, onDestinationChange, onChange, parametersOnly = false }: {
  parametersOnly?: boolean
  addresses: string[]
  onProviderChange: (provider: string) => void
  onDestinationChange: (patch: Partial<Pick<OutputSettings, 'base_url' | 'region' | 'app_id'>>) => void
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
  const secretField = (field: SpeechSecret, label: string, placeholder?: string) =>
    <SpeechSecretField key={`${speechDestinationKey(value)}:${field}`} kind="speech-output" connection={value}
      field={field} label={label} placeholder={placeholder} onChange={secret => onChange({ [field]: secret })} />
  return <>
    {!parametersOnly && <>
    <label>{t('tts.provider')}<Select value={value.provider} onChange={event => onProviderChange(event.target.value)}>{providers.filter(p => value.mode === 'remote' ? ['voicebox', 'openai'].includes(p.id) : p.id !== 'voicebox').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
    {(value.mode === 'remote' || value.provider === 'openai') && <SpeechAddressField value={value.base_url} addresses={addresses}
      placeholder={provider?.base_url} onChange={base_url => onDestinationChange({ base_url })} />}
    {value.provider === 'tencent' ? <>
      {secretField('secret_id', 'SecretId')}
      {secretField('secret_key', 'SecretKey')}
      <label>{t('tts.region')}<Input value={value.region} onChange={e => onDestinationChange({ region: e.target.value })} /></label>
    </> : secretField('api_key', 'API Key', value.mode === 'remote' ? t('tts.optionalKey') : undefined)}
    {value.provider === 'qwen' && <label>{t('tts.region')}<Select value={value.region} onChange={e => onDestinationChange({ region: e.target.value })}><option value="beijing">{t('tts.beijing')}</option><option value="singapore">{t('tts.singapore')}</option></Select></label>}
    {value.provider === 'volcengine' && <>
      <label>{t('tts.resourceId')}<Input value={value.resource_id} onChange={e => onChange({ resource_id: e.target.value })} /></label>
      <label>{t('tts.appId')}<Input value={value.app_id} onChange={e => onDestinationChange({ app_id: e.target.value })} /></label>
    </>}
    {!['tencent', 'volcengine'].includes(value.provider) && <label>{t('tts.model')}<Input list={value.provider === 'qwen' ? 'speech-qwen-models' : undefined} value={value.model} onChange={e => onChange({ model: e.target.value, instructions: '' })} /></label>}
    {value.provider === 'qwen' && <datalist id="speech-qwen-models"><option value="qwen3-tts-flash-realtime" /><option value="qwen3-tts-instruct-flash-realtime" /></datalist>}
    {value.provider === 'voicebox' && <label>{t('tts.engine')}<Select value={value.engine} onChange={e => onChange({ engine: e.target.value, instructions: '' })}><option value="qwen">Qwen Base</option><option value="qwen_custom_voice">Qwen CustomVoice</option><option value="kokoro">Kokoro</option></Select></label>}
    </>}
    <label>{t(value.provider === 'voicebox' ? 'tts.profileId' : 'digitalPerson.voiceName')}{voices.length ? <Select value={value.voice} onChange={e => onChange({ voice: e.target.value })}><option value="">{t('tts.chooseVoice')}</option>{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</Select> : <Input value={value.voice} onChange={e => onChange({ voice: e.target.value })} />}</label>
    {value.provider === 'voicebox' && <div className="speech-output-actions"><Button loading={loading} disabled={loading || !value.base_url.trim()} onClick={() => void discover()}>{t('tts.readVoices')}</Button>{error && <span role="alert">{localizeErrorDisplay(error)}</span>}</div>}
    {!parametersOnly && <p className="speech-output-hint">{t(provider?.streaming ? 'tts.streaming' : 'tts.sentence')}</p>}
  </>
}
