import { useEffect, useRef, useState, type CSSProperties } from 'react'
import Icon from './Icon'
import { useI18n } from '../i18n'
import type { ChatContextUsage, ChatEngineQuota } from './ChatInput'

interface ChatInputUsageProps {
  context?: ChatContextUsage | null
  quota?: ChatEngineQuota | null
  onRefreshQuota?: () => void
  quotaRefreshing?: boolean
  compact: boolean
}

export default function ChatInputUsage({
  context, quota, onRefreshQuota, quotaRefreshing = false, compact,
}: ChatInputUsageProps) {
  const { t, locale } = useI18n()
  const [contextTipOpen, setContextTipOpen] = useState(false)
  const contextRef = useRef<HTMLSpanElement>(null)
  const [contextTipStyle, setContextTipStyle] = useState<CSSProperties | undefined>(undefined)
  const [quotaTipOpen, setQuotaTipOpen] = useState(false)
  const quotaRef = useRef<HTMLSpanElement>(null)
  const [quotaTipStyle, setQuotaTipStyle] = useState<CSSProperties | undefined>(undefined)

  useEffect(() => {
    if (!contextTipOpen && !quotaTipOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setContextTipOpen(false)
      }
      if (quotaRef.current && !quotaRef.current.contains(e.target as Node)) {
        setQuotaTipOpen(false)
      }
    }
    document.addEventListener('click', handleClickOutside, true)
    return () => document.removeEventListener('click', handleClickOutside, true)
  }, [contextTipOpen, quotaTipOpen])

  const formatTokens = (count: number) =>
    new Intl.NumberFormat(locale).format(Math.max(0, Math.round(count)))

  return (
    <>
          {quota?.primary && (
            <span
              ref={quotaRef}
              className={`chat-input-context chat-input-quota${quotaTipOpen ? ' is-tip-open' : ''}`}
              tabIndex={0}
              role="button"
              onClick={() => {
                if (compact && quotaRef.current) {
                  const rect = quotaRef.current.getBoundingClientRect()
                  setQuotaTipStyle({ bottom: window.innerHeight - rect.top + 8 })
                } else {
                  setQuotaTipStyle(undefined)
                }
                setQuotaTipOpen((open) => !open)
              }}
            >
              {t('chatInput.quotaCompact', { remaining: quota.primary.remaining_percent })}
              <span className={`chat-input-context-tip chat-input-quota-tip${compact && quotaTipOpen ? ' is-compact-positioned' : ''}`} style={quotaTipStyle}>
                <span className="chat-input-quota-heading">
                  <strong>{quota.limit_name || t('chatInput.quotaTitle')}</strong>
                  {onRefreshQuota && (
                    <button
                      type="button"
                      className="chat-input-quota-refresh"
                      data-quota-refresh=""
                      disabled={quotaRefreshing}
                      aria-label={t('common.refresh')}
                      title={t('common.refresh')}
                      onClick={(event) => {
                        event.stopPropagation()
                        onRefreshQuota()
                      }}
                    >
                      {quotaRefreshing
                        ? <span className="task-status-spinner" aria-hidden="true" />
                        : <Icon name="refresh" size={13} strokeWidth={2} />}
                    </button>
                  )}
                </span>
                <span>{t('chatInput.quotaPrimary', {
                  remaining: quota.primary.remaining_percent,
                })}</span>
                <span>{t('chatInput.quotaReset', {
                  reset: quota.primary.resets_at
                    ? new Date(quota.primary.resets_at * 1000).toLocaleString(locale)
                    : t('chatInput.quotaResetUnknown'),
                })}</span>
                {quota.secondary && (
                  <span>{t('chatInput.quotaSecondary', {
                    remaining: quota.secondary.remaining_percent,
                  })}</span>
                )}
                {quota.credits && (
                  <span>{quota.credits.unlimited
                    ? t('chatInput.quotaCreditsUnlimited')
                    : t('chatInput.quotaCredits', { balance: quota.credits.balance ?? '0' })}</span>
                )}
                {quota.individual_limit && (
                  <span>{t('chatInput.quotaIndividual', {
                    used: quota.individual_limit.used,
                    limit: quota.individual_limit.limit,
                    remaining: quota.individual_limit.remaining_percent,
                  })}</span>
                )}
              </span>
            </span>
          )}
          {context && (
            <span
              ref={contextRef}
              className={`chat-input-context chat-input-context-breakdown-wrap${contextTipOpen ? ' is-tip-open' : ''}${context.percent > 90 ? ' is-critical' : context.percent > 70 ? ' is-warning' : ''}`}
              tabIndex={0}
              role="button"
              onClick={() => {
                if (compact && contextRef.current) {
                  const rect = contextRef.current.getBoundingClientRect()
                  setContextTipStyle({ bottom: window.innerHeight - rect.top + 8 })
                } else {
                  setContextTipStyle(undefined)
                }
                setContextTipOpen((v) => !v)
              }}
              aria-label={t('chatInput.contextTokens', { used: formatTokens(context.used), total: formatTokens(context.total) })}
            >
              <svg className="chat-input-context-ring" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="chat-input-context-ring-track" cx="12" cy="12" r="9" pathLength="100" />
                <circle
                  className="chat-input-context-ring-value"
                  cx="12"
                  cy="12"
                  r="9"
                  pathLength="100"
                  strokeDasharray={`${Math.min(100, Math.max(0, context.percent))} 100`}
                />
              </svg>
              <span>{Math.round(context.percent)}%</span>
              <span className={`chat-input-context-tip chat-input-context-detail${compact && contextTipOpen ? ' is-compact-positioned' : ''}`} style={contextTipStyle}>
                <span className="chat-input-context-heading">
                  <strong>{t('chatInput.contextCompact', { percent: Math.round(context.percent) })}</strong>
                  <span>{context.estimated ? '~' : ''}{formatTokens(context.used)} / {formatTokens(context.total)}</span>
                </span>
                <span className="chat-input-context-meter"><i style={{ width: `${Math.min(100, context.percent)}%` }} /></span>
                {context.breakdown && (
                  <>
                    <span className="chat-input-context-section-title">
                      {context.breakdown.estimated ? t('chatInput.contextBreakdownEstimated') : t('chatInput.contextBreakdown')}
                    </span>
                    {([
                      ['system', 'contextSystem'],
                      ['toolDefinitions', 'contextToolDefinitions'],
                      ['user', 'contextUserMessages'],
                      ['assistant', 'contextAssistantMessages'],
                      ['toolRequests', 'contextToolRequests'],
                      ['toolResults', 'contextToolResults'],
                      ['other', 'contextOther'],
                    ] as const).filter(([key]) => context.breakdown![key] > 0).map(([key, label]) => (
                      <span className={`chat-input-context-row chat-input-context-row--${key}`} key={key}>
                        <i />
                        <span>{t(`chatInput.${label}`)}</span>
                        <code>~{formatTokens(context.breakdown![key])}</code>
                        <em>{Math.round((context.breakdown![key] / context.used) * 100)}%</em>
                      </span>
                    ))}
                    {context.tools && context.tools.length > 0 && (
                      <>
                        <span className="chat-input-context-section-title">{t('chatInput.contextToolsTop')}</span>
                        {context.tools.map((tool) => (
                          <span className="chat-input-context-tool" key={tool.name}>
                            <code>{tool.name}</code>
                            <span>~{formatTokens(tool.tokens)}</span>
                            <em>{Math.round((tool.tokens / context.used) * 100)}%</em>
                          </span>
                        ))}
                      </>
                    )}
                  </>
                )}
              </span>
            </span>
          )}
    </>
  )
}
