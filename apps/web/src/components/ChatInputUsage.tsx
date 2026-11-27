import { useEffect, useRef, useState, type CSSProperties } from 'react'
import EngineQuotaPopover from './EngineQuotaPopover'
import { useEngineQuota } from '../hooks/useEngineQuota'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import type { QuotaResult } from '../api/client'
import { useI18n } from '../i18n'
import type { ChatContextUsage, ChatEngineQuota } from './ChatInput'

interface ChatInputUsageProps {
  managed?: boolean
  projectId?: string
  selectedEngine?: string
  conversationKey?: string
  active?: boolean
  entries?: QuotaResult[]
  context?: ChatContextUsage | null
  quota?: ChatEngineQuota | null
  onRefreshQuota?: () => void
  quotaRefreshing?: boolean
  compact: boolean
}

export default function ChatInputUsage({
  context, quota, onRefreshQuota, quotaRefreshing = false, compact,
  managed = false, projectId, selectedEngine = '', conversationKey, active = true, entries,
}: ChatInputUsageProps) {
  const { t, locale } = useI18n()
  const [contextTipOpen, setContextTipOpen] = useState(false)
  const contextRef = useRef<HTMLSpanElement>(null)
  const [contextTipStyle, setContextTipStyle] = useState<CSSProperties | undefined>(undefined)
  const { bound: projectScoped } = useGatewayProjectPermissions(projectId)
  const quotaFetchEnabled = active && managed && (!projectScoped || Boolean(projectId))
  const unified = useEngineQuota(projectId, selectedEngine, conversationKey, quotaFetchEnabled)

  useEffect(() => {
    if (!contextTipOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setContextTipOpen(false)
      }

    }
    document.addEventListener('click', handleClickOutside, true)
    return () => document.removeEventListener('click', handleClickOutside, true)
  }, [contextTipOpen])

  const formatTokens = (count: number) =>
    new Intl.NumberFormat(locale).format(Math.max(0, Math.round(count)))

  return (
    <>
      <EngineQuotaPopover compact={compact} selectedEngine={selectedEngine}
        entries={managed ? unified.entries : entries ?? (quota ? [{engine_id: quota.engine_id, supported: true, status: 'ok', quota}] : [])}
        alwaysVisible={managed} error={managed && unified.error} collectedAt={managed ? unified.collectedAt : quota?.collected_at}
        refreshing={managed ? quotaFetchEnabled && unified.refreshing : quotaRefreshing}
        onRefresh={managed ? () => { void unified.refresh() } : onRefreshQuota} />
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
