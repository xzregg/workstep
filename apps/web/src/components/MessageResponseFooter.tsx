import Icon from './Icon'
import { useEffect, useMemo, useState } from 'react'
import { engineLabel } from '../engineMeta'
import Button from './Button'
import {
  durationMilliseconds,
  formatConversationDateTime,
  toMilliseconds,
  type DateTimeValue,
} from '../utils/datetime'
import {
  estimateUsageFromEvents,
  estimateUsageFromEventSummary,
} from '../utils/contextUsage.js'
import {
  buildMessageTimeline,
  thinkingRateFromTimeline,
  type MessageTimelineEvent,
} from '../utils/messageTimeline'
import { useI18n, zhCNT, type TFunction } from '../i18n'

export {
  usageFromEvents,
  estimateUsageFromEvents,
} from '../utils/contextUsage.js'

/* ══════════════════════════════════════════
   MessageResponseFooter — shared LLM message footer
   (usage / engine / model summary + response actions).
   Used by the task conversation and the AI flow-design
   chat so both render replies with the same footer.
   ══════════════════════════════════════════ */

export type MessageUsage = Record<string, unknown> | null | undefined

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
  engine?: string | null,
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
  const cacheInputIncluded = typeof usage.cache_input_included === 'boolean'
    ? usage.cache_input_included
    : engine !== 'claude' && engine !== 'claude_agent_sdk'
  const cacheInput = cacheInputIncluded === false
    ? input + cacheRead + cacheWrite
    : input
  if (cacheInput > 0) {
    const cacheHitRate = Math.min(100, (cacheRead / cacheInput) * 100)
    parts.push(t('footer.cacheHit', { pct: cacheHitRate.toFixed(1) }))
  }
  parts.push(t('footer.total', { count: number.format(total) }))
  if (usage.estimated === true) parts.push(t('footer.estimated'))
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
        fontSize: 'calc(11px * var(--font-scale))',
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

/** 事件时间戳：AG-UI 事件用 timestamp，旧内部事件用 created_at。 */
function eventTimestamp(event: any): number | null {
  return toMilliseconds(event?.created_at ?? event?.timestamp)
}

/**
 * 进行中速率（t/s）：按已产出的 output token 除以已运行时长。
 * startedAt 缺省时回退到最早一条事件时间；时长不足 1 秒或无输出时返回 null，
 * 避免刚起步就出现夸张的速率数字。
 */
export function tokensPerSecond(
  outputTokens: number,
  elapsedMs: number | null,
): number | null {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null
  if (elapsedMs === null || elapsedMs < 1000) return null
  return Math.max(1, Math.round(outputTokens / (elapsedMs / 1000)))
}

/** 模型「吐词」事件：正文/思考增量与首个正文事件，用于计算首 token 时延。 */
const OUTPUT_EVENT_TYPES = new Set([
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CHUNK',
  'TEXT_MESSAGE_CONTENT',
  'REASONING_MESSAGE_CHUNK',
  'agent_message_chunk',
  'agent_thought_chunk',
  'thinking_delta',
])

/**
 * 首次吐词时延（秒）：消息开始时刻到第一条输出事件的时间差。
 * startedAt 缺省时回退到最早一条事件时间（通常是 RUN_STARTED）；
 * 事件里没有输出增量（还没吐词 / 只有摘要投影）时返回 null，不显示该项。
 */
export function firstTokenDelaySeconds(
  events: unknown[] | undefined,
  startedAt?: DateTimeValue,
  eventSummary?: Record<string, unknown> | null,
): number | null {
  const summaryFirstOutputAt = eventSummary?.first_output_at
  if (typeof summaryFirstOutputAt === 'string' && startedAt) {
    const start = toMilliseconds(startedAt)
    const firstOutput = toMilliseconds(summaryFirstOutputAt)
    if (start !== null && firstOutput !== null && firstOutput >= start) {
      return (firstOutput - start) / 1000
    }
  }
  let earliest: number | null = null
  let firstOutput: number | null = null
  for (const raw of events ?? []) {
    const event = raw as { type?: string } | null
    const timestamp = eventTimestamp(event)
    if (timestamp === null) continue
    if (earliest === null || timestamp < earliest) earliest = timestamp
    if (!event?.type || !OUTPUT_EVENT_TYPES.has(event.type)) continue
    if (firstOutput === null || timestamp < firstOutput) firstOutput = timestamp
  }
  const start = toMilliseconds(startedAt) ?? earliest
  if (start === null || firstOutput === null) return null
  const seconds = (firstOutput - start) / 1000
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return seconds
}

/** 秒数展示：10 秒以内保留一位小数，之后取整。 */
export function formatSeconds(seconds: number): string {
  if (seconds < 10) {
    return String(Math.round(seconds * 10) / 10)
  }
  return String(Math.round(seconds))
}

export interface MessageResponseFooterProps {
  content: string
  usage?: MessageUsage
  /** 消息原始事件流：running 且无 usage_update 时按字符数估算 token。 */
  events?: unknown[]
  /** 刷新后的持久化事件摘要：停止消息缺少详细事件时恢复 token 估算。 */
  eventSummary?: Record<string, unknown> | null
  engine?: string | null
  model?: string | null
  executionModel?: string | null
  /** 消息开始时刻：进行中计算 t/s 速率；缺省时回退到最早事件时间。 */
  startedAt?: DateTimeValue
  endedAt?: string | number | null
  running?: boolean
  /** 该阶段被手动停止：悬停消息时显示「重启」。 */
  stopped?: boolean
  onContinueStage?: () => void
  /** Create an independent chat branch from this completed response. */
  onFork?: () => void
}

export default function MessageResponseFooter({
  content,
  usage,
  events,
  eventSummary,
  engine,
  model,
  executionModel,
  startedAt,
  endedAt,
  running = false,
  stopped = false,
  onContinueStage,
  onFork,
}: MessageResponseFooterProps) {
  const { t, locale } = useI18n()
  // 进行中或手动停止且引擎未上报 usage_update 时，按已接收事件与字符数量换算估算值。
  // running 时 fallback 文本恒为 ''（不随 token 变），故 memo 只跟随 events 引用：
  // 纯文本流式期间 events 引用不变 → 跳过整段事件扫描，避免每 token O(事件数) 重算。
  const fallbackText = stopped ? content : ''
  const eventEstimated = useMemo(
    () => ((running || stopped) && !usage
      ? estimateUsageFromEvents(events ?? [], fallbackText)
      : null),
    [running, stopped, usage, events, fallbackText],
  )
  const estimated = eventEstimated
    ?? (stopped && !usage ? estimateUsageFromEventSummary(eventSummary) : null)
  const effectiveUsage = usage ?? estimated
  const usageSummary = effectiveUsage
    ? formatTokenUsage(effectiveUsage, t, locale, engine)
    : running
      ? ''
      : formatTokenUsage(usage, t, locale, engine)

  // 进行中每秒刷新一次时钟，让 t/s 与耗时保持流动；结束后停止计时器。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  // 最早事件时间：单趟扫描 + memo（替代 events.map().filter() 建两个数组再
  // Math.min(...) 展开——后者每 token 重算且大数组展开有爆栈风险）。
  const earliestEventMs = useMemo(() => {
    let min: number | null = null
    for (const raw of events ?? []) {
      const ts = eventTimestamp(raw)
      if (ts !== null && (min === null || ts < min)) min = ts
    }
    return min
  }, [events])
  const elapsedMs = running
    ? durationMilliseconds(toMilliseconds(startedAt) ?? earliestEventMs, now)
    : null
  const thinkingRate = useMemo(
    () => running ? thinkingRateFromTimeline(buildMessageTimeline((events ?? []) as MessageTimelineEvent[]), now) : null,
    [running, events, now],
  )
  const outputTokens = usageValue(effectiveUsage, 'output_tokens', 'completion_tokens')
  const summaryOutputTokens = outputTokens > 0
    ? outputTokens
    : usageValue(effectiveUsage, 'reasoning_output_tokens', 'thought_tokens')
  const rateElapsedMs = running
    ? elapsedMs
    : typeof eventSummary?.elapsed_ms === 'number'
      ? eventSummary.elapsed_ms
      : null
  const rate = thinkingRate ?? tokensPerSecond(summaryOutputTokens, rateElapsedMs)
  // 首 token 时延：开始 → 第一条吐词事件；进行中与结束后都展示。memo 同上。
  const ttftSeconds = useMemo(
    () => firstTokenDelaySeconds(events, startedAt, eventSummary),
    [events, startedAt, eventSummary],
  )

  // 进行中也展示引擎与模型：Token 估算 · t/s · 首t · 引擎 * 模型
  const summaryParts = [
    usageSummary || null,
    rate !== null ? t('footer.rate', { rate }) : null,
    ttftSeconds !== null
      ? t('footer.firstToken', { seconds: formatSeconds(ttftSeconds) })
      : null,
    [
      engine ? engineLabel(engine, t) : null,
      model ? `* ${model}` : null,
    ].filter(Boolean).join(' ') || null,
  ].filter((part): part is string => Boolean(part))

  return (
    <div style={{
      minHeight: 24, display: 'flex', alignItems: 'center', gap: 8,
      color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))',
    }}>
      <span className="footer-usage-summary" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        {summaryParts.join(' · ')}
        {executionModel && executionModel !== model
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
            fontSize: 'calc(11px * var(--font-scale))', color: 'var(--accent)',
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            whiteSpace: 'nowrap', minHeight: 24, flexShrink: 0,
          }}
        >
          <Icon name="rotate-ccw" size={11} strokeWidth={2.2} />
          {t('footer.restart')}
        </button>
      )}
      {!running && onFork && (
        <Button
          variant="ghost"
          aria-label={t('chatSession.forkAction')}
          title={t('chatSession.forkTitle')}
          onClick={onFork}
          className="chat-message-action"
          style={{
            width: 24, height: 24, minWidth: 24, padding: 0,
            justifyContent: 'center', color: 'var(--muted)',
          }}
        >
          <Icon name="git-fork" size={12} strokeWidth={2} />
        </Button>
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
