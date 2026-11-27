import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Icon from './Icon'
import { useI18n } from '../i18n'
import { engineLabel } from '../engineMeta'
import type { EngineQuotaWindow, QuotaResult } from '../api/client'

export default function EngineQuotaPopover({ entries, selectedEngine = '', compact, refreshing = false, error = false,
  alwaysVisible = false, onRefresh }: {
  entries: QuotaResult[]; selectedEngine?: string; compact: boolean; refreshing?: boolean; error?: boolean
  alwaysVisible?: boolean; onRefresh?: () => void
}) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const [position, setPosition] = useState<CSSProperties>()
  const ref = useRef<HTMLSpanElement>(null)
  const selected = entries.find(entry => entry.engine_id === selectedEngine)
  const focused = selected || (entries.length === 1 ? entries[0] : undefined)
  const visible = all || !focused ? entries : [focused]
  const primary = focused?.quota?.primary
  const label = primary ? t('chatInput.quotaCompact', {remaining: primary.remaining_percent}) : t('chatInput.quotaTitle')
  useEffect(() => { setAll(false) }, [selectedEngine])
  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight
      const width = Math.min(400, Math.max(240, viewportWidth - 32))
      const below = rect.top < Math.min(280, viewportHeight / 2)
      const available = below ? viewportHeight - rect.bottom - 24 : rect.top - 24
      setPosition({
        left: Math.max(16, Math.min(rect.left, viewportWidth - width - 16)),
        width,
        ...(below
          ? { top: rect.bottom + 8, maxHeight: Math.min(560, Math.max(160, available)) }
          : { bottom: viewportHeight - rect.top + 8, maxHeight: Math.min(560, Math.max(160, available)) }),
      })
    }
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus() } }
    update()
    document.addEventListener('click', outside, true)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      document.removeEventListener('click', outside, true)
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [open])
  if (!alwaysVisible && !entries.length) return null
  const resetText = (reset?: number | null) => reset
    ? t('chatInput.quotaReset', {reset: new Date(reset * 1000).toLocaleString(locale)}) : t('chatInput.quotaResetUnknown')
  const windowRow = (window: EngineQuotaWindow, index: number) => <span className="engine-quota-window" key={index}>
    <span className="engine-quota-window-info">
      <span>{window.label || (window.kind === 'weekly' ? t('chatInput.quotaWeekly') : window.kind === 'five-hour'
        ? t('chatInput.quotaFiveHour') : window.window_duration_mins
          ? t('chatInput.quotaMinutes', {minutes: window.window_duration_mins}) : window.kind || t('chatInput.quotaTitle'))}</span>
      <span className="engine-quota-reset" title={resetText(window.resets_at)}>{resetText(window.resets_at)}</span>
      <strong>{window.remaining_percent}%</strong>
    </span>
    <span className="engine-quota-meter" role="progressbar" aria-label={window.label || window.kind || t('chatInput.quotaTitle')}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remaining_percent}>
      <i style={{width: `${Math.min(100, Math.max(0, window.remaining_percent))}%`}} />
    </span>
  </span>
  return <span ref={ref} className={`chat-input-context chat-input-quota${open ? ' is-tip-open' : ''}`}
    aria-label={label} onClick={event => { if (event.target === event.currentTarget) setOpen(value => !value) }}>
    <button className="engine-quota-trigger" type="button" aria-label={label} aria-expanded={open}
      onClick={() => setOpen(value => !value)}>
      {compact ? <><Icon name="circle-dollar-sign" size={14} /><span>{primary ? `${primary.remaining_percent}%` : label}</span></> : label}
    </button>
    <span className="chat-input-quota-tip engine-quota-panel" style={position} role="dialog" aria-label={t('chatInput.quotaTitle')}
      hidden={!open} onClick={event => event.stopPropagation()}>
      <span className="chat-input-quota-heading">
        <strong>{t('chatInput.quotaTitle')}</strong>
        {onRefresh && <button type="button" className="chat-input-quota-refresh" data-quota-refresh="" disabled={refreshing}
          aria-label={t('common.refresh')} title={t('common.refresh')} onClick={onRefresh}>
          {refreshing ? <span className="task-status-spinner" aria-hidden="true" /> : <Icon name="refresh" size={14} />}
        </button>}
      </span>
      {focused && entries.length > 1 && <span className="engine-quota-filters">
        <button type="button" aria-pressed={!all} onClick={() => setAll(false)}>{focused.name || engineLabel(focused.engine_id, t)}</button>
        <button type="button" data-quota-all="" aria-pressed={all} onClick={() => setAll(true)}>{t('chatInput.quotaAll')}</button>
      </span>}
      <span className="engine-quota-cards">
        {error && <span className="engine-quota-status" role="status">{t('chatInput.quotaUnavailable')}</span>}
        {!entries.length && <span className="engine-quota-status" role="status">{refreshing
          ? <><span className="task-status-spinner" />{t('chatInput.quotaLoading')}</> : !error ? t('chatInput.quotaEmpty') : null}</span>}
        {visible.map(entry => {
          const title = entry.name || engineLabel(entry.engine_id, t)
          return <span className="engine-quota-card" data-quota-engine={entry.engine_id} key={entry.engine_id}>
          <span className="engine-quota-card-heading"><strong>{title}</strong>
            {entry.quota?.plan_type && <span className="engine-quota-plan">{entry.quota.plan_type}</span>}</span>
          {entry.status !== 'ok' || !entry.quota ? <span className="engine-quota-status">{entry.status === 'unauthenticated'
            ? t('chatInput.quotaLogin') : t('chatInput.quotaUnavailable')}</span> : <>
            {entry.quota.limit_name && entry.quota.limit_name !== title && <span className="engine-quota-limit-name">{entry.quota.limit_name}</span>}
            {(entry.quota.groups?.length ? entry.quota.groups : [{name: '', windows: [
              entry.quota.primary, entry.quota.secondary,
            ].filter((window): window is EngineQuotaWindow => Boolean(window))}]).map((group, index) => <span className="chat-input-quota-group" key={index}>
              {group.name && <strong>{group.name}</strong>}{group.windows.map(windowRow)}
            </span>)}
            {entry.quota.credits && <span className="engine-quota-balance">{entry.quota.credits.unlimited ? t('chatInput.quotaCreditsUnlimited')
              : t('chatInput.quotaCredits', {balance: [entry.quota.credits.balance, entry.quota.credits.unit].filter(Boolean).join(' ')})}</span>}
            {entry.quota.individual_limit && <span className="engine-quota-balance">{t('chatInput.quotaIndividual', {
              used: entry.quota.individual_limit.used, limit: entry.quota.individual_limit.limit,
              remaining: entry.quota.individual_limit.remaining_percent,
            })}<span className="engine-quota-reset">{resetText(entry.quota.individual_limit.resets_at)}</span></span>}
          </>}
        </span>
        })}
      </span>
    </span>
  </span>
}
