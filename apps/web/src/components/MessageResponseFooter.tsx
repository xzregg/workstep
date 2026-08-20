import Icon from './Icon'
import { useState } from 'react'
import { engineLabel } from '../engineMeta'
import Button from './Button'
import { formatConversationDateTime } from '../utils/datetime'
import { useI18n, zhCNT, type TFunction } from '../i18n'

/* ══════════════════════════════════════════
   MessageResponseFooter — shared LLM message footer
   (usage / engine / model summary + copy button).
   Used by the task conversation and the AI flow-design
   chat so both render replies with the same footer.
   ══════════════════════════════════════════ */

export type MessageUsage = Record<string, unknown> | null | undefined

export function usageFromEvents(events: any[]): MessageUsage {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (
      (event?.type === 'usage' || event?.type === 'usage_update')
      && event.data && typeof event.data === 'object'
    ) {
      return event.data as Record<string, unknown>
    }
    if (
      event?.type === 'CUSTOM'
      && event?.name === 'workstep.usage'
      && event?.value && typeof event.value === 'object'
    ) {
      return event.value as Record<string, unknown>
    }
  }
  return null
}

function usageValue(usage: MessageUsage, ...keys: string[]) {
  for (const key of keys) {
    const value = usage?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

export function formatTokenUsage(
  usage?: MessageUsage,
  t: TFunction = zhCNT,
  locale = 'zh-CN',
): string {
  if (!usage || Object.keys(usage).length === 0) {
    return t('footer.noTokenData')
  }
  if (usage.usage_kind === 'context_window') {
    const used = usageValue(usage, 'used')
    const size = usageValue(usage, 'size')
    const number = new Intl.NumberFormat(locale)
    const occupancy = size > 0
      ? t('footer.occupancy', { pct: Math.min(100, (used / size) * 100).toFixed(1) })
      : ''
    return `${t('footer.context', {
      used: number.format(used),
      size: number.format(size),
    })}${occupancy}`
  }
  const input = usageValue(usage, 'input_tokens', 'prompt_tokens')
  const output = usageValue(usage, 'output_tokens', 'completion_tokens')
  const cacheRead = usageValue(
    usage,
    'cache_read_input_tokens',
    'cached_tokens',
  )
  const cacheWrite = usageValue(usage, 'cache_creation_input_tokens')
  const reportedTotal = usageValue(usage, 'total_tokens')
  const total = reportedTotal || input + output
  const number = new Intl.NumberFormat(locale)
  const parts = input > 0 || output > 0
    ? [
        t('footer.input', { count: number.format(input) }),
        t('footer.output', { count: number.format(output) }),
      ]
    : []
  if (cacheRead > 0) parts.push(t('footer.cacheRead', { count: number.format(cacheRead) }))
  if (cacheWrite > 0) parts.push(t('footer.cacheWrite', { count: number.format(cacheWrite) }))
  const cacheInput = 'prompt_tokens' in usage
    ? input
    : input + cacheRead + cacheWrite
  if (cacheInput > 0) {
    const cacheHitRate = Math.min(100, (cacheRead / cacheInput) * 100)
    parts.push(t('footer.cacheHit', { pct: cacheHitRate.toFixed(1) }))
  }
  parts.push(t('footer.total', { count: number.format(total) }))
  return `${t('footer.tokenPrefix')}${parts.join(' · ')}`
}

export async function copyMessageText(content: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Copy failed')
}

export function MessageCopyButton({
  content,
  className = '',
  title,
  disabled = false,
}: {
  content: string
  className?: string
  title?: string
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    try {
      await copyMessageText(content)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }
  return (
    <Button
      variant="ghost"
      aria-label={copyState === 'copied' ? t('meta.copyMessageDone') : t('meta.copyMessage')}
      title={copyState === 'copied'
        ? t('common.copied')
        : copyState === 'failed'
          ? t('meta.copyFailed')
          : (title ?? t('meta.copyMessage'))}
      disabled={disabled || !content}
      onClick={() => void copy()}
      className={className}
      style={{
        width: 24, height: 24, minWidth: 24, padding: 0,
        justifyContent: 'center',
        color: copyState === 'failed'
          ? 'var(--danger)'
          : copyState === 'copied'
            ? 'var(--success)'
            : 'var(--muted)',
        fontSize: 11,
      }}
    >
      {copyState === 'copied' ? (
        <Icon name="check" size={13} strokeWidth={2.4} />
      ) : (
        <Icon name="copy" size={12} strokeWidth={2} />
      )}
    </Button>
  )
}

export interface MessageResponseFooterProps {
  content: string
  usage?: MessageUsage
  engine?: string | null
  model?: string | null
  executionModel?: string | null
  endedAt?: string | number | null
  running?: boolean
  /** 该阶段被手动停止：悬停消息时显示「重启」。 */
  stopped?: boolean
  onContinueStage?: () => void
}

export default function MessageResponseFooter({
  content,
  usage,
  engine,
  model,
  executionModel,
  endedAt,
  running = false,
  stopped = false,
  onContinueStage,
}: MessageResponseFooterProps) {
  const { t, locale } = useI18n()
  const usageSummary = running ? '' : formatTokenUsage(usage, t, locale)

  return (
    <div style={{
      minHeight: 24, display: 'flex', alignItems: 'center', gap: 8,
      color: 'var(--meta)', fontSize: 11,
    }}>
      <span className="footer-usage-summary" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        {usageSummary}
        {!running && engine ? ` · ${engineLabel(engine, t)}` : ''}
        {!running && model ? ` * ${model}` : ''}
        {!running && executionModel && executionModel !== model
          ? t('footer.executionModel', { model: executionModel })
          : ''}
      </span>
      {stopped && onContinueStage && (
        <button
          type="button"
          className="chat-message-action"
          title={t('footer.restartTitle')}
          onClick={onContinueStage}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 11, color: 'var(--accent)',
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            whiteSpace: 'nowrap', minHeight: 24, flexShrink: 0,
          }}
        >
          <Icon name="rotate-ccw" size={11} strokeWidth={2.2} />
          {t('footer.restart')}
        </button>
      )}
      <MessageCopyButton
        content={content}
        title={running ? t('meta.copyDisabledTitle') : t('meta.copyMessage')}
        disabled={running}
        className="chat-message-action"
      />
      {!running && endedAt && (
        <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {formatConversationDateTime(endedAt, Date.now(), locale)}
        </span>
      )}
    </div>
  )
}
