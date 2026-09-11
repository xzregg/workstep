import { useMemo } from 'react'
import { useI18n, type TKey } from '../i18n'
import Input from './Input'

interface Props {
  id?: string
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}

type Alias = 'sonnet' | 'opus' | 'haiku' | 'fable'
type Entry = { model: string; name: string }

const aliases: { alias: Alias; labelKey: TKey }[] = [
  { alias: 'sonnet', labelKey: 'engineForm.modelMapRoleSonnet' },
  { alias: 'opus', labelKey: 'engineForm.modelMapRoleOpus' },
  { alias: 'haiku', labelKey: 'engineForm.modelMapRoleHaiku' },
  { alias: 'fable', labelKey: 'engineForm.modelMapRoleFable' },
]

function parseValue(value: string): { entries: Partial<Record<Alias, Entry>>; error: boolean } {
  if (!value.trim()) return { entries: {}, error: false }
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { entries: {}, error: true }
    }
    const entries: Partial<Record<Alias, Entry>> = {}
    for (const { alias } of aliases) {
      const raw = (parsed as Record<string, unknown>)[alias]
      if (raw === undefined) continue
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { entries: {}, error: true }
      }
      const model = (raw as Record<string, unknown>).model
      const name = (raw as Record<string, unknown>).name
      if (typeof model !== 'string' || (name !== undefined && typeof name !== 'string')) {
        return { entries: {}, error: true }
      }
      entries[alias] = {
        model,
        name: typeof name === 'string' && name !== model ? name : '',
      }
    }
    return { entries, error: false }
  } catch {
    return { entries: {}, error: true }
  }
}

export default function ModelMapEditor({ id, value, disabled = false, onChange }: Props) {
  const { t } = useI18n()
  const parsed = useMemo(() => parseValue(value), [value])

  const update = (alias: Alias, field: keyof Entry, nextValue: string) => {
    if (parsed.error) return
    const nextEntries: Partial<Record<Alias, Entry>> = {
      ...parsed.entries,
      [alias]: {
        model: parsed.entries[alias]?.model ?? '',
        name: parsed.entries[alias]?.name ?? '',
        [field]: nextValue,
      },
    }
    const output: Partial<Record<Alias, Entry>> = {}
    for (const { alias: currentAlias } of aliases) {
      const entry = nextEntries[currentAlias]
      if (!entry?.model.trim()) continue
      output[currentAlias] = {
        model: entry.model,
        name: entry.name,
      }
    }
    onChange(Object.keys(output).length ? JSON.stringify(output) : '')
  }

  return (
    <div id={id} data-model-map-editor="" style={{ display: 'grid', gap: 8 }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr) minmax(0, 1fr)',
        gap: 8, color: 'var(--muted)', fontSize: 'calc(11px * var(--font-scale))',
      }}>
        <span />
        <span>{t('engineForm.modelMapModelLabel')}</span>
        <span>{t('engineForm.modelMapNameLabel')}</span>
      </div>
      {aliases.map(({ alias, labelKey }) => {
        const entry = parsed.entries[alias]
        return (
          <div
            key={alias}
            data-alias={alias}
            style={{
              display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr) minmax(0, 1fr)',
              alignItems: 'start', gap: 8,
            }}
          >
            <span style={{ paddingTop: 7, fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600 }}>
              {t(labelKey)}
            </span>
            <Input
              data-field="model"
              aria-label={`${t(labelKey)} ${t('engineForm.modelMapModelLabel')}`}
              value={entry?.model ?? ''}
              disabled={disabled || parsed.error}
              placeholder={t('engineForm.modelMapModelPlaceholder')}
              onChange={(event) => update(alias, 'model', event.target.value)}
            />
            <Input
              data-field="name"
              aria-label={`${t(labelKey)} ${t('engineForm.modelMapNameLabel')}`}
              value={entry?.name ?? ''}
              disabled={disabled || parsed.error}
              placeholder={t('engineForm.modelMapNamePlaceholder')}
              onChange={(event) => update(alias, 'name', event.target.value)}
            />
          </div>
        )
      })}
      {parsed.error && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 'calc(11px * var(--font-scale))' }}>
          {t('engineForm.modelMapParseError')}
        </div>
      )}
    </div>
  )
}
