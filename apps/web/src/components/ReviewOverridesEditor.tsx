import Input from './Input'
import MarkdownEditor from './MarkdownEditor'
import { useI18n } from '../i18n'

export interface ReviewOverride {
  mode: 'skip' | 'auto' | 'manual'
  auto: boolean
  prompt: string
  maxRetries: number
}

interface LaneLike { key: string; label: string; color?: string }

interface Props {
  value: Record<string, ReviewOverride>
  onChange: (value: Record<string, ReviewOverride>) => void
  lanes: LaneLike[]
  startStepKey?: string | null
  projectId?: string
}

export default function ReviewOverridesEditor({ value, onChange, lanes, startStepKey, projectId }: Props) {
  const { t } = useI18n()
  const startIndex = Math.max(0, lanes.findIndex((lane) => lane.key === startStepKey))
  const update = (key: string, patch: Partial<ReviewOverride>) => {
    onChange({ ...value, [key]: { ...value[key], ...patch } })
  }
  if (Object.keys(value).length === 0) {
    return <div style={{ color: 'var(--meta)', fontSize: 13, textAlign: 'center', paddingTop: 40 }}>{t('taskList.noReviewConfig')}</div>
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    {Object.entries(value).map(([key, cfg]) => {
      const lane = lanes.find((item) => item.key === key)
      const label = lane?.label || key
      const color = lane?.color || 'var(--meta)'
      const laneIndex = lanes.findIndex((item) => item.key === key)
      const upstream = startIndex >= 0 && laneIndex >= 0 && laneIndex < startIndex
      return <div key={key} style={{ padding: '10px 12px', borderRadius: 6, background: upstream ? 'transparent' : `color-mix(in oklab, ${color}, transparent 96%)`, border: `1px solid ${upstream ? 'var(--border)' : `color-mix(in oklab, ${color}, transparent 85%)`}`, opacity: upstream ? .4 : 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} /><strong style={{ fontSize: 13 }}>{label}</strong>{upstream && <span style={{ fontSize: 11, color: 'var(--meta)' }}>{t('status.skipped')}</span>}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {([['skip', t('flow.reviewSkip')], ['auto', t('flow.autoReview')], ['manual', t('flow.manualReview')]] as const).map(([mode, text]) => <button key={mode} type="button" disabled={upstream} onClick={() => update(key, { mode, auto: mode === 'auto' })} style={{ padding: '2px 8px', fontSize: 11, borderRadius: 999, border: cfg.mode === mode ? '1px solid var(--accent)' : '1px solid var(--border)', background: cfg.mode === mode ? 'var(--accent-light)' : 'transparent', color: cfg.mode === mode ? 'var(--accent)' : 'var(--fg-2)' }}>{text}</button>)}
          {cfg.mode === 'auto' && <label style={{ fontSize: 11, color: 'var(--meta)' }}>{t('flow.retry')} <Input type="number" min={1} max={5} disabled={upstream} value={cfg.maxRetries} onChange={(event) => update(key, { maxRetries: Math.max(1, Math.min(5, Number(event.target.value) || 1)) })} style={{ width: 42, height: 22 }} /></label>}
        </div>
        <MarkdownEditor value={cfg.prompt} onChange={(prompt) => update(key, { prompt })} disabled={upstream} projectId={projectId} placeholder={t('taskList.reviewPromptPlaceholder')} minHeight={28} maxHeight={120} ariaLabel={t('taskList.reviewPromptAria', { label })} />
      </div>
    })}
  </div>
}
