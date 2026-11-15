import { useI18n } from '../i18n'
import Button from './Button'
import Textarea from './Textarea'

const groups = [
  { label: 'tonePresets', exclusive: true, keys: ['bright', 'deep'] },
  { label: 'stylePresets', exclusive: false, keys: ['gentle', 'lively', 'mature', 'tsundere'] },
] as const

export default function VoiceStyleSettings({ value, enabled, required, local, onChange, hideUnsupported = false }: {
  hideUnsupported?: boolean
  value: string; enabled: boolean; required?: boolean; local?: boolean; onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const parts = value.split('；').map(s => s.trim()).filter(Boolean)
  return <section className="speech-voice-style" data-voice-instructions data-local-instructions={local && enabled || undefined}>
    {enabled ? <>
      <label>{t(required ? 'tts.voiceDescription' : 'tts.voicePrompt')}<Textarea rows={3} maxLength={2000}
        value={value} aria-required={required || undefined} placeholder={t('tts.voicePromptExample')}
        onChange={event => onChange(event.target.value)} /></label>
      {groups.map(group => <div className="speech-voice-presets" key={group.label}>
        <span>{t(`tts.${group.label}`)}</span><div className="speech-output-actions">
          {group.keys.map(key => {
            const phrase = t(`tts.prompt_${key}`), active = parts.includes(phrase)
            const remaining = parts.filter(part => part !== phrase && (!group.exclusive || !group.keys.some(k => part === t(`tts.prompt_${k}`))))
            const next = [...remaining, ...(active ? [] : [phrase])].join('；')
            return <Button size="sm" key={key} aria-pressed={active} disabled={next.length > 2000}
              onClick={() => onChange(next)}>{t(`tts.preset_${key}`)}</Button>
          })}
        </div>
      </div>)}
    </> : !hideUnsupported && <p className="speech-output-hint">{t('tts.voicePromptUnsupported')}</p>}
  </section>
}
