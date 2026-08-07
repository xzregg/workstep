import { useState } from 'react'
import { engineLabel } from '../engineMeta'

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
    if (event?.type === 'usage' && event.data && typeof event.data === 'object') {
      return event.data as Record<string, unknown>
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

export function formatTokenUsage(usage?: MessageUsage) {
  if (!usage || Object.keys(usage).length === 0) {
    return 'Token：暂无数据'
  }
  if (usage.usage_kind === 'context_window') {
    const used = usageValue(usage, 'used')
    const size = usageValue(usage, 'size')
    const number = new Intl.NumberFormat('zh-CN')
    const occupancy = size > 0 ? ` · 占用 ${Math.min(100, (used / size) * 100).toFixed(1)}%` : ''
    return `Token · 上下文 ${number.format(used)} / ${number.format(size)}${occupancy}`
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
  const number = new Intl.NumberFormat('zh-CN')
  const parts = input > 0 || output > 0
    ? [`输入 ${number.format(input)}`, `输出 ${number.format(output)}`]
    : []
  if (cacheRead > 0) parts.push(`缓存读取 ${number.format(cacheRead)}`)
  if (cacheWrite > 0) parts.push(`缓存写入 ${number.format(cacheWrite)}`)
  const cacheInput = 'prompt_tokens' in usage
    ? input
    : input + cacheRead + cacheWrite
  if (cacheInput > 0) {
    const cacheHitRate = Math.min(100, (cacheRead / cacheInput) * 100)
    parts.push(`缓存命中 ${cacheHitRate.toFixed(1)}%`)
  }
  const cost = usage.cost as { amount?: number; currency?: string } | number | undefined
  if (cost !== undefined && cost !== null) {
    const amount = typeof cost === 'object' ? cost.amount : cost
    const currency = typeof cost === 'object' && cost.currency ? cost.currency : 'USD'
    if (typeof amount === 'number' && Number.isFinite(amount)) {
      parts.push(`金额 ${amount.toFixed(2)} ${currency}`)
    }
  }
  parts.push(`总计 ${number.format(total)}`)
  return `Token · ${parts.join(' · ')}`
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

export interface MessageResponseFooterProps {
  content: string
  usage?: MessageUsage
  engine?: string | null
  model?: string | null
  executionModel?: string | null
  running?: boolean
}

export default function MessageResponseFooter({
  content,
  usage,
  engine,
  model,
  executionModel,
  running = false,
}: MessageResponseFooterProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const usageSummary = running ? '' : formatTokenUsage(usage)

  const copy = async () => {
    try {
      await copyMessageText(content)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div style={{
      minHeight: 24, display: 'flex', alignItems: 'center', gap: 8,
      color: 'var(--meta)', fontSize: 10,
    }}>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        {usageSummary}
        {!running && engine ? ` · ${engineLabel(engine)}` : ''}
        {!running && model ? ` * ${model}` : ''}
        {!running && executionModel && executionModel !== model
          ? ` · 执行 ${executionModel}`
          : ''}
      </span>
      <button
        type="button"
        className="btn-ghost"
        aria-label={copyState === 'copied' ? '消息已复制' : '复制 LLM 消息'}
        title={running
          ? '消息生成完成后可复制'
          : copyState === 'copied'
            ? '已复制'
            : copyState === 'failed'
              ? '复制失败'
              : '复制消息'}
        disabled={running || !content}
        onClick={() => void copy()}
        style={{
          width: 24, height: 24, minWidth: 24, padding: 0,
          justifyContent: 'center',
          color: copyState === 'failed'
            ? 'var(--danger)'
            : copyState === 'copied'
              ? 'var(--success)'
              : 'var(--muted)',
          fontSize: 10,
        }}
      >
        {copyState === 'copied' ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
            <path d="m5 12 4 4L19 6" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  )
}
