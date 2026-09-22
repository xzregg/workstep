import { useI18n } from '../i18n'
import type { ForkContextMode } from '../utils/chatSessionFork'

interface Props {
  modes: ForkContextMode[]
  value: ForkContextMode
  messageCount: number
  disabled?: boolean
  name: string
  onChange: (value: ForkContextMode) => void
}

export default function ChatHandoffOptions({
  modes,
  value,
  messageCount,
  disabled = false,
  name,
  onChange,
}: Props) {
  const { t } = useI18n()

  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend className="field-label" style={{ marginBottom: 8 }}>
        {t('chatSession.forkContext')}
      </legend>
      <div style={{ display: 'grid', gap: 8 }}>
        {modes.map((mode) => (
          <label
            key={mode}
            style={{
              display: 'grid',
              gridTemplateColumns: '18px minmax(0, 1fr)',
              gap: 10,
              alignItems: 'start',
              padding: '11px 12px',
              border: `1px solid ${value === mode ? 'var(--accent)' : 'var(--border-soft)'}`,
              borderRadius: 12,
              background: value === mode ? 'var(--accent-soft)' : 'var(--bg)',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            <input
              type="radio"
              name={name}
              value={mode}
              checked={value === mode}
              disabled={disabled}
              onChange={() => onChange(mode)}
              style={{ marginTop: 2 }}
            />
            <span style={{ minWidth: 0 }}>
              <strong style={{ display: 'block', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--fg)' }}>
                {t(`chatSession.forkMode_${mode}`)}
              </strong>
              <span style={{ display: 'block', marginTop: 3, fontSize: 'calc(12px * var(--font-scale))', lineHeight: 1.5, color: 'var(--muted)' }}>
                {t(`chatSession.forkMode_${mode}Hint`, { count: messageCount })}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
