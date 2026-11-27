import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import Icon from './Icon'
import { useI18n } from '../i18n'
import { engineLabel } from '../engineMeta'
import type { EngineQuotaWindow, QuotaResult } from '../api/client'

export default function EngineQuotaPopover({ entries, selectedEngine = '', compact, refreshing = false, error = false,
  alwaysVisible = false, collectedAt, onRefresh }: {
  entries: QuotaResult[]; selectedEngine?: string; compact: boolean; refreshing?: boolean; error?: boolean
  alwaysVisible?: boolean; collectedAt?: number; onRefresh?: () => void
}) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const [position, setPosition] = useState<CSSProperties>()
  const ref = useRef<HTMLSpanElement>(null)
  const uid = useId()
  const selected = selectedEngine ? entries.find(entry => entry.engine_id === selectedEngine) : undefined
  const focused = selected || (entries.length === 1 ? entries[0] : undefined)
  const visible = all || !focused ? entries : [focused]
  const triggerPrimary = selected?.quota?.primary
  const tabbed = Boolean(focused) && entries.length > 1
  const tabs = focused ? [
    { key: 'focused', all: false, label: focused.name || engineLabel(focused.engine_id, t) },
    { key: 'all', all: true, label: t('chatInput.quotaAll') },
  ] : []
  const moveTab = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length
    setAll(tabs[next].all)
    ref.current?.querySelector<HTMLButtonElement>(`[data-quota-tab="${tabs[next].key}"]`)?.focus()
  }
  const label = triggerPrimary ? t('chatInput.quotaCompact', {remaining: triggerPrimary.remaining_percent}) : t('chatInput.quotaShort')
  useEffect(() => { setAll(false) }, [selectedEngine])
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const viewportLeft = viewport?.offsetLeft ?? 0
      const viewportTop = viewport?.offsetTop ?? 0
      const viewportWidth = viewport?.width ?? window.innerWidth
      const viewportHeight = viewport?.height ?? window.innerHeight
      const viewportBottom = viewportTop + viewportHeight
      const width = Math.min(320, Math.max(0, viewportWidth - 32))
      const belowTop = Math.max(viewportTop + 16, rect.bottom + 8)
      const aboveBottom = Math.min(viewportBottom - 16, rect.top - 8)
      const spaceBelow = viewportBottom - 16 - belowTop
      const spaceAbove = aboveBottom - viewportTop - 16
      const below = spaceBelow > spaceAbove
      setPosition({
        left: Math.max(viewportLeft + 16, Math.min(rect.left, viewportLeft + viewportWidth - width - 16)),
        width,
        maxHeight: Math.min(420, Math.max(0, below ? spaceBelow : spaceAbove)),
        ...(below
          ? { top: belowTop }
          : { bottom: window.innerHeight - aboveBottom }),
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
  const collectedDate = collectedAt === undefined ? null : new Date(collectedAt * 1000)
  const resetText = (reset?: number | null) => reset
    ? t('chatInput.quotaReset', {reset: new Date(reset * 1000).toLocaleString(locale)}) : t('chatInput.quotaResetUnknown')
  const windowLabel = (window: EngineQuotaWindow) => window.label
    || (window.kind === 'weekly' || window.window_duration_mins === 10080 ? t('chatInput.quotaWeekly')
      : window.kind === 'five-hour' || window.window_duration_mins === 300 ? t('chatInput.quotaFiveHour')
        : window.window_duration_mins ? t('chatInput.quotaMinutes', {minutes: window.window_duration_mins})
          : window.kind || t('chatInput.quotaTitle'))
  const failureText = (entry: QuotaResult) => {
    if (entry.status === 'unauthenticated') return t('chatInput.quotaLogin')
    switch (entry.reason) {
      case 'timeout': return t('chatInput.quotaTimeout')
      case 'command_failed': return t('chatInput.quotaCommandFailed')
      case 'invalid_report': return t('chatInput.quotaInvalidReport')
      default: return t('chatInput.quotaUnavailable')
    }
  }
  const windowRow = (window: EngineQuotaWindow, index: number) => <span className="engine-quota-window" key={index}>
    <span className="engine-quota-window-info">
      <span>{windowLabel(window)}</span>
      <span className="engine-quota-reset" title={resetText(window.resets_at)}>{resetText(window.resets_at)}</span>
      <strong>{window.remaining_percent}%</strong>
    </span>
    <span className="engine-quota-meter" role="progressbar" aria-label={windowLabel(window)}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remaining_percent}>
      <i style={{width: `${Math.min(100, Math.max(0, window.remaining_percent))}%`}} />
    </span>
  </span>
  return <span ref={ref} className={`chat-input-context chat-input-quota${open ? ' is-tip-open' : ''}`}
    aria-label={label} onClick={event => { if (event.target === event.currentTarget) setOpen(value => !value) }}>
    <button className="engine-quota-trigger" type="button" aria-label={label} aria-expanded={open}
      onClick={() => setOpen(value => !value)}>
      {compact ? <><Icon name="circle-dollar-sign" size={14} /><span>{triggerPrimary ? `${triggerPrimary.remaining_percent}%` : label}</span></> : label}
    </button>
    <span className="chat-input-quota-tip engine-quota-panel" style={position} role="dialog" aria-label={t('chatInput.quotaTitle')}
      hidden={!open} onClick={event => event.stopPropagation()}>
      <span className="chat-input-quota-heading">
        <strong>{t('chatInput.quotaTitle')}</strong>
        {collectedDate && Number.isFinite(collectedDate.getTime()) && <time className="engine-quota-updated" dateTime={collectedDate.toISOString()}
          title={t('chatInput.quotaLastRefresh', {time: collectedDate.toLocaleString(locale)})}>
          {t('chatInput.quotaLastRefresh', {time: collectedDate.toLocaleTimeString(locale, {hour: 'numeric', minute: '2-digit'})})}
        </time>}
        {onRefresh && <button type="button" className="chat-input-quota-refresh" data-quota-refresh="" disabled={refreshing}
          aria-label={t('common.refresh')} title={t('common.refresh')} onClick={onRefresh}>
          {refreshing ? <span className="task-status-spinner" aria-hidden="true" /> : <Icon name="refresh" size={14} />}
        </button>}
      </span>
      {tabbed && <span className="engine-quota-tabs" role="tablist" aria-label={t('chatInput.quotaTitle')}>
        {tabs.map((tab, index) => <button key={tab.key} id={`${uid}-${tab.key}`} type="button" role="tab" title={tab.label}
          aria-selected={all === tab.all} aria-controls={`${uid}-panel`} tabIndex={all === tab.all ? 0 : -1}
          data-quota-tab={tab.key} {...(tab.all ? { 'data-quota-all': '' } : {})}
          onClick={() => setAll(tab.all)} onKeyDown={event => moveTab(event, index)}>{tab.label}</button>)}
      </span>}
      <span className="engine-quota-cards" id={`${uid}-panel`} {...(tabbed ? { role: 'tabpanel', 'aria-labelledby': `${uid}-${all ? 'all' : 'focused'}` } : {})}>
        {error && <span className="engine-quota-status" role="status">{t('chatInput.quotaUnavailable')}
          {visible.some(entry => entry.quota) && <> · {t('chatInput.quotaLastKnown')}</>}</span>}
        {!entries.length && (refreshing || !error) && <span className="engine-quota-status" role="status">{refreshing
          ? <><span className="task-status-spinner" />{t('chatInput.quotaLoading')}</> : t('chatInput.quotaEmpty')}</span>}
        {visible.map(entry => {
          const title = entry.name || engineLabel(entry.engine_id, t)
          return <span className="engine-quota-card" data-quota-engine={entry.engine_id} key={entry.engine_id}>
          <span className="engine-quota-card-heading"><strong>{title}</strong>
            {entry.quota?.plan_type && <span className="engine-quota-plan">{entry.quota.plan_type}</span>}</span>
          {(entry.status !== 'ok' || !entry.quota) && <span className="engine-quota-status">{failureText(entry)}
            {entry.quota && <> · {t('chatInput.quotaLastKnown')}</>}</span>}
          {entry.quota && <>
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
