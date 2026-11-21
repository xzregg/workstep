import { useState } from 'react'
import { useI18n } from '../i18n'
import Input from './Input'
import Select from './Select'
import './VoiceModelMirror.css'

const chinaMirror = 'https://hf-mirror.com'

export function formatVoiceModelSize(bytes: number) {
  const unit = bytes >= 1024 ** 3 ? 'GiB' : 'MiB'
  return `${(bytes / (unit === 'GiB' ? 1024 ** 3 : 1024 ** 2)).toFixed(1)} ${unit}`
}

function validMirror(value: string) {
  try {
    const url = new URL(value)
    return /^https?:\/\/[^/@?#]+(?:\/|$)/i.test(value) && !!url.hostname && !url.username && !url.password
      && url.port !== '0' && !/[\s\\?#]/u.test(value) && value.length <= 2000
  } catch { return false }
}

export function useVoiceModelMirror(scope: 'input' | 'output') {
  const key = `workstep:voice-model-mirror:${scope}`
  const [stored] = useState(() => {
    try {
      return window.localStorage.getItem(key)
        ?? (scope === 'output' ? window.localStorage.getItem('workstep:voice-model-mirror:input') : null) ?? ''
    } catch { return '' }
  })
  const [source, setSource] = useState<'official' | 'china' | 'custom'>(
    stored === chinaMirror ? 'china' : stored ? 'custom' : 'official',
  )
  const [custom, setCustom] = useState(stored === chinaMirror ? '' : stored)
  const mirror = source === 'china' ? chinaMirror : source === 'custom' ? custom.trim() : undefined
  const valid = source !== 'custom' || validMirror(custom.trim())
  const remember = (value: string) => {
    try { window.localStorage.setItem(key, value) } catch { /* Storage can be disabled by the browser. */ }
  }
  return {
    source, custom, mirror, valid,
    choose(value: typeof source) {
      setSource(value)
      if (value === 'official') remember('')
      else if (value === 'china') remember(chinaMirror)
      else remember(validMirror(custom.trim()) ? custom.trim() : '')
    },
    edit(value: string) {
      setCustom(value)
      remember(validMirror(value.trim()) ? value.trim() : '')
    },
  }
}

export default function VoiceModelMirror({ settings, disabled }: {
  settings: ReturnType<typeof useVoiceModelMirror>; disabled: boolean
}) {
  const { t } = useI18n()
  return <div className="voice-model-mirror">
    <label>{t('voiceModel.source')}<Select data-model-mirror value={settings.source} disabled={disabled}
      onChange={event => settings.choose(event.target.value as typeof settings.source)}>
      <option value="official">Hugging Face</option>
      <option value="china">{t('voiceModel.china')}</option>
      <option value="custom">{t('voiceModel.custom')}</option>
    </Select></label>
    {settings.source === 'custom' && <label>{t('voiceModel.address')}<Input data-custom-model-mirror
      value={settings.custom} type="url" maxLength={2000} disabled={disabled}
      aria-invalid={!settings.valid} placeholder="https://mirror.example.com"
      onChange={event => settings.edit(event.target.value)} /></label>}
    {settings.source === 'custom' && !settings.valid && <p>{t('voiceModel.invalid')}</p>}
    <p>{t('voiceModel.runtimeHint')}</p>
  </div>
}
