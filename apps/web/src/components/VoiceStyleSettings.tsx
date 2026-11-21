import { useI18n } from '../i18n'
import type { OutputModel } from '../api/speechOutput'
import Button from './Button'
import Textarea from './Textarea'

const groups = [
  { exclusive: true, keys: ['bright', 'deep'] },
  { exclusive: false, keys: ['gentle', 'lively', 'mature', 'tsundere'] },
] as const
const paceGroup = { exclusive: true, keys: ['slow', 'fast'] } as const
const tonePresets = [
  ['neutral', 'tts.toneNeutral'], ['warm', 'tts.toneWarm'], ['happy', 'tts.toneBright'], ['whisper', 'tts.toneWhisper'],
] as const

type VoiceStyle = Exclude<NonNullable<OutputModel['style']>, ''>

export default function VoiceStyleSettings({ value, enabled, required, local, onChange, hideUnsupported = false, preview = false, style = 'instruction', designAttributes, unavailableDesignGroups = [], cloning = false, pacePresets = false }: {
  hideUnsupported?: boolean
  preview?: boolean
  style?: VoiceStyle
  designAttributes?: OutputModel['design_attributes']
  unavailableDesignGroups?: string[]
  cloning?: boolean
  pacePresets?: boolean
  value: string; enabled: boolean; required?: boolean; local?: boolean; onChange: (value: string) => void
}) {
  const { t, locale } = useI18n()
  const maxLength = preview ? 500 : 2000
  const parts = value.split('；').map(s => s.trim()).filter(Boolean)
  const evening = t('tts.eveningVoicePrompt')
  const presets = style === 'tone'
    ? tonePresets.map(([id, key]) => {
      const label = t(key)
      const active = value === id
      return { id, label, active, next: active ? '' : id }
    })
    : [
      ...(local ? [{ id: 'evening', label: t('tts.eveningVoicePreset'), active: parts.includes(evening),
        next: parts.includes(evening) ? parts.filter(part => part !== evening).join('；') : evening }] : []),
      ...(pacePresets ? [...groups, paceGroup] : groups).flatMap(group => group.keys.map(key => {
        const phrase = t(`tts.prompt_${key}`), active = parts.includes(phrase)
        const remaining = parts.filter(part => part !== phrase && (!group.exclusive || !group.keys.some(k => part === t(`tts.prompt_${k}`))))
        return { id: key, label: t(`tts.preset_${key}`), active, next: [...remaining, ...(active ? [] : [phrase])].join('；') }
      })),
    ]
  const attributeParts = value.split(',').map(part => part.trim()).filter(Boolean)
  const attributeGroups = (['gender', 'age', 'pitch', 'style', 'accent', 'dialect'] as const).flatMap(group => {
    const choices = designAttributes?.[group]
    if (!choices) return []
    const items = Object.entries(choices)
    const remaining = attributeParts.filter(part => !items.some(([id]) => part === id))
    return [{
      label: t(`tts.design_${group}`), unavailable: unavailableDesignGroups.includes(group),
      items: items.map(([id, localized]) => {
        const label = locale.startsWith('zh') ? localized : id
        const active = attributeParts.includes(id)
        return { id, label, active, next: [...remaining, ...(active ? [] : [id])].join(', ') }
      }),
    }]
  })
  const rows = designAttributes ? attributeGroups : [{
    label: t(style === 'tone' ? 'tts.tonePresets' : 'tts.stylePresets'), items: presets, unavailable: false,
  }]
  return <section className="speech-voice-style" data-voice-instructions data-local-instructions={local && enabled || undefined}>
    {enabled ? <>
      {style === 'tone' && <p className="speech-output-hint">{t(designAttributes
        ? cloning ? 'tts.cloneDesignHelp' : 'tts.design_help' : 'tts.clonePresetHelp')}</p>}
      {rows.map(({ label: group, items, unavailable }) => <div key={group}>
        {designAttributes && <span className="speech-output-hint">{group}</span>}
        <div className="speech-voice-presets" role="group" aria-label={group}>
          {items.map(({ id, label, active, next }) => <Button size="sm" key={id} aria-pressed={active} disabled={unavailable || next.length > maxLength}
            onClick={() => onChange(next)}>{label}</Button>)}
        </div>
      </div>)}
      {style === 'instruction' && <label>{t(preview ? 'tts.omniPreviewPrompt' : required ? 'tts.voiceDescription' : 'tts.voicePrompt')}
        <Textarea rows={3} maxLength={maxLength} value={value} aria-required={required || undefined}
          placeholder={t('tts.voicePromptExample')} onChange={event => onChange(event.target.value)} />
      </label>}
    </> : !hideUnsupported && <p className="speech-output-hint">{t('tts.voicePromptUnsupported')}</p>}
  </section>
}
