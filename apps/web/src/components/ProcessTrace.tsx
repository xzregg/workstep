import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MessageCopyButton } from './MessageResponseFooter'
import SubagentTimelineItem from './SubagentTimelineItem'
import StreamingStatusText from './StreamingStatusText'
import MarkdownMessage from './MarkdownMessage'
import ToolTimelineItem from './ToolTimelineItem'
import {
  durationMilliseconds,
  formatDuration,
  toMilliseconds,
  type DateTimeValue,
} from '../utils/datetime'
import { useI18n } from '../i18n'
import {
  buildMessageTimeline,
  estimateTokens,
  type MessageTimelineItem,
} from '../utils/messageTimeline'
import { isToolEvent, toolCallId } from '../utils/agui.ts'
import {
  conversationBottomScrollTop,
  isNearConversationBottom,
  shouldPauseConversationFollow,
} from '../pages/taskDetailChat'

type ProcessEvent = {
  type: string
  data?: Record<string, unknown>
  timestamp?: DateTimeValue
}

/**
 * 展开时一次性渲染的时间线条目上限。巨型消息（子代理长回合、上万条事件）
 * 全量渲染会产生数万个 DOM 节点与等量的 Markdown/工具行组件，渲染进程内存
 * 瞬间飙升直接崩掉标签页。默认只渲染最近 N 条；更早的条目由「显示全部」
 * 按钮显式加载（用户知情选择，而非静默丢数据）。
 */
const MAX_RENDERED_PROCESS_ITEMS = 400

interface ProcessTraceProps {
  events: ProcessEvent[]
  running?: boolean
  /** 该条 LLM 消息被手动停止（summary 显示“在 X 后停止了”）。 */
  stopped?: boolean
  startedAt?: DateTimeValue
  endedAt?: DateTimeValue
  compact?: boolean
  summaryMeta?: ReactNode
  eventSummary?: {
    thought_characters?: number
    commentary_characters?: number
    tool_count?: number
  }
  detailsAvailable?: boolean
  detailsLoaded?: boolean
  detailsLoading?: boolean
  detailsError?: string
  onLoadDetails?: () => void
  /** 项目 id：把 read/edit 工具目标解析为可预览的项目文件链接。 */
  projectId?: string
}

function ThinkingTimelineItem({
  content,
  active,
  lastThinking,
  duration,
  elapsedMs,
}: {
  content: string
  active: boolean
  /** 是否为当前消息中最后一个思考块；只有最后一个思考块结束后不自动折叠。 */
  lastThinking: boolean
  duration: string
  elapsedMs?: number
}) {
  const { t } = useI18n()
  const displayDuration = duration || formatDuration(0, t)
  const [open, setOpen] = useState(active)
  const thinkingRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const lastProgrammaticScrollTopRef = useRef(0)
  useEffect(() => {
    if (active) {
      setOpen(true)
      followRef.current = true
    } else if (!lastThinking) {
      // 非最后一个思考块：结束后自动折叠
      setOpen(false)
    }
    // 最后一个思考块：结束后不自动缩回，保留用户当前展开/折叠状态
  }, [active, lastThinking])
  useLayoutEffect(() => {
    if (!active || !open || !followRef.current) return
    const container = thinkingRef.current
    if (!container) return
    const target = conversationBottomScrollTop(
      container.scrollHeight,
      container.clientHeight,
    )
    lastProgrammaticScrollTopRef.current = target
    container.scrollTop = target
    lastScrollTopRef.current = target
  }, [active, content, open])

  return (
    <div className="process-trace-thinking-row">
    <details
      className="process-trace-thinking-block"
      data-active={active ? 'true' : undefined}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="process-trace-section-title">
        <span className="process-trace-summary-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path
              d="M12 2a7 7 0 0 0-4.6 12.3c.6.5 1 1.2 1.1 2l.2 1.2c.1.6.6 1 1.2 1h4.2c.6 0 1.1-.4 1.2-1l.2-1.2c.1-.8.5-1.5 1.1-2A7 7 0 0 0 12 2Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M9 21h6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className={active ? 'process-trace-thinking-label is-shimmer' : 'process-trace-thinking-label'}>
          {active
            ? t('trace.thinkingProgress', {
              count: estimateTokens(content),
              duration: displayDuration,
              rate: elapsedMs && elapsedMs > 0
                ? Math.max(1, Math.round(estimateTokens(content) / (elapsedMs / 1000)))
                : '—',
            })
            : duration
              ? t('trace.thoughtCharactersDuration', {
                count: estimateTokens(content),
                duration,
              })
              : t('trace.thoughtCharacters', { count: estimateTokens(content) })}
        </span>
        <svg className="process-trace-chevron" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path
            d="m19.5 8.25-7.5 7.5-7.5-7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div
        ref={thinkingRef}
        className="process-trace-thinking"
        tabIndex={0}
        aria-label={t('trace.thinking')}
        onWheelCapture={(event) => {
          if (shouldPauseConversationFollow({ type: 'wheel', deltaY: event.deltaY })) {
            followRef.current = false
          }
        }}
        onKeyDownCapture={(event) => {
          if (shouldPauseConversationFollow({ type: 'key', key: event.key })) {
            followRef.current = false
          }
        }}
        onScroll={(event) => {
          const container = event.currentTarget
          const programmaticEcho = Math.abs(
            container.scrollTop - lastProgrammaticScrollTopRef.current,
          ) <= 1
          if (!programmaticEcho) {
            if (container.scrollTop < lastScrollTopRef.current) {
              followRef.current = false
            } else if (isNearConversationBottom(
              container.scrollHeight,
              container.scrollTop,
              container.clientHeight,
              4,
            )) {
              followRef.current = true
            }
          }
          lastScrollTopRef.current = container.scrollTop
        }}
      >
        {content.trimStart()}
      </div>
    </details>
    {/* 复制按钮移出 <summary>：交互元素放在 summary 内会触发浏览器可访问性
        告警（键盘/读屏行为不一致）；作为行级 flex 兄弟节点视觉位置不变。 */}
    <span className="process-trace-thinking-copy">
      <MessageCopyButton content={content} title={t('trace.copyThinking')} />
    </span>
    </div>
  )
}

export default function ProcessTrace({
  events,
  running = false,
  stopped = false,
  startedAt,
  endedAt,
  compact = false,
  summaryMeta,
  eventSummary,
  detailsAvailable = false,
  detailsLoaded = false,
  detailsLoading = false,
  detailsError,
  onLoadDetails,
  projectId,
}: ProcessTraceProps) {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(running)
  const [showAllItems, setShowAllItems] = useState(false)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  useEffect(() => {
    setOpen(running)
  }, [running])

  // 时间线与各项统计全部按 events 引用 memo：running 时秒针每秒 tick、父级
  // 每 token 重渲染，不 memo 会导致每次 tick 都对数千条事件全量重建时间线
  // （buildMessageTimeline 会拼接思考文本，产生大量临时字符串 → GC 风暴）。
  const timeline = useMemo(() => buildMessageTimeline(events), [events])
  const processItems = useMemo(
    () => timeline.filter(
      (item): item is Exclude<MessageTimelineItem, { type: 'text' }> => item.type !== 'text',
    ),
    [timeline],
  )
  const lastProcessItem = timeline[timeline.length - 1]
  const thinkingItems = useMemo(
    () => processItems.filter(
      (item): item is Extract<MessageTimelineItem, { type: 'thinking' }> => item.type === 'thinking',
    ),
    [processItems],
  )
  const lastThinkingItem = thinkingItems[thinkingItems.length - 1]
  const subagentItems = useMemo(
    () => processItems.filter(
      (item): item is Extract<MessageTimelineItem, { type: 'subagent' }> => item.type === 'subagent',
    ),
    [processItems],
  )
  const lastSubagentItem = subagentItems[subagentItems.length - 1]
  // 按工具调用去重计数：一次命令/工具调用会拆成 start/args/chunk/result
  // 多条事件（尤其流式参数会逐块产生大量 chunk），不能把事件数当命令数。
  const eventCommandCount = useMemo(() => new Set(events
    .filter((event) => event.type === 'tool_use' || isToolEvent(event))
    .map((event) => {
      if (event.type === 'tool_use') {
        const data = event.data ?? {}
        return String(data.id ?? data.tool_use_id ?? '')
      }
      return toolCallId(event)
    })
    .filter((id) => id !== '')).size, [events])
  const commandCount = detailsLoaded || !detailsAvailable
    ? eventCommandCount
    : eventSummary?.tool_count ?? eventCommandCount
  // 事件时间范围单趟扫描取 min/max（Math.min(...arr) 大数组展开有爆栈风险）。
  const { minEventMs, maxEventMs } = useMemo(() => {
    let min: number | null = null
    let max: number | null = null
    for (const event of events) {
      const ts = toMilliseconds(event.timestamp)
      if (ts === null) continue
      if (min === null || ts < min) min = ts
      if (max === null || ts > max) max = ts
    }
    return { minEventMs: min, maxEventMs: max }
  }, [events])
  const startTime = toMilliseconds(startedAt) ?? minEventMs
  const endTime = running
    ? now
    : toMilliseconds(endedAt) ?? maxEventMs
  let elapsedMs = durationMilliseconds(startTime, endTime)
  // 旧数据回补：消息没返回 ended_at、且 startedAt 实为完成时刻（不早于最后一条事件）时，
  // 起点取最早事件时间、终点取原 startedAt，避免刷新后丢失耗时。
  if (elapsedMs === null && !running && minEventMs !== null && maxEventMs !== null) {
    const startedMs = toMilliseconds(startedAt)
    if (startedMs !== null && startedMs >= maxEventMs) {
      elapsedMs = durationMilliseconds(minEventMs, startedMs)
    }
  }
  // 历史回放缺少 ended_at 的旧数据：起点=消息落库完成时刻、终点回退到最后事件，
  // 二者可能相等得出无意义的「耗时 0秒」，此时不展示耗时。
  const duration = elapsedMs === null || (!running && elapsedMs === 0)
    ? ''
    : formatDuration(elapsedMs, t)

  if (!duration && processItems.length === 0 && !summaryMeta && !detailsAvailable) return null

  const toggleSession = () => {
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen && detailsAvailable && !detailsLoaded && !detailsLoading) {
      onLoadDetails?.()
    }
  }

  // 渲染封顶：默认只挂载最近 MAX_RENDERED_PROCESS_ITEMS 条，避免巨型 trace
  // 一次性生成数万 DOM 节点压垮渲染进程。
  const hiddenItemCount = !showAllItems && processItems.length > MAX_RENDERED_PROCESS_ITEMS
    ? processItems.length - MAX_RENDERED_PROCESS_ITEMS
    : 0
  const visibleProcessItems = hiddenItemCount > 0
    ? processItems.slice(hiddenItemCount)
    : processItems

  return (
    <div className={`process-trace${compact ? ' process-trace-compact' : ''}`}>
      {/* 受控 disclosure 取代原生 <details>/<summary>：
          ① summaryMeta 里的交互元素（会话 ID popover、查看提示词按钮）不再是
             <summary> 后代，消除可访问性告警；
          ② 头部行与 body 为兄弟节点，body 占满整行宽度（meta 不挤压过程正文）；
          ③ body 条件渲染——已完成消息默认折叠，巨型 trace 不再隐藏占用 DOM，
             打开长对话时只挂载头部行。 */}
      <div className="process-trace-session" data-open={open ? 'true' : undefined}>
        <div
          className="process-trace-session-summary"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={toggleSession}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            toggleSession()
          }}
        >
          <span className={running ? 'process-trace-thinking-label is-shimmer' : undefined}>
            {running ? t('trace.processing') : stopped ? '' : t('trace.processed')}
            {!running && stopped
              ? (duration ? t('trace.stoppedAfter', { duration }) : t('trace.stopped'))
              : (duration ? ` ${duration}` : '')}
            {commandCount > 0 && t('trace.commandCount', { count: commandCount })}
          </span>
          <svg className="process-trace-chevron" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path
              d="m19.5 8.25-7.5 7.5-7.5-7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {summaryMeta}
        </div>
        {open && (
        <div className="process-trace-body">
          {detailsLoading && (
            <StreamingStatusText label={t('trace.loadingDetails')} />
          )}
          {!detailsLoading && detailsError && (
            <div style={{ color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>{detailsError}</div>
          )}
          {!detailsLoading && !detailsError && detailsAvailable && !detailsLoaded && Boolean(eventSummary?.thought_characters) && (
            <div style={{ color: 'var(--meta)', fontSize: 'calc(12px * var(--font-scale))' }}>
              {t('trace.thoughtCharacters', { count: eventSummary?.thought_characters ?? 0 })}
            </div>
          )}
          {!detailsLoading && detailsLoaded && processItems.length === 0 && null}
          {hiddenItemCount > 0 && (
            <div className="process-trace-empty">
              {t('trace.itemsHidden', { count: hiddenItemCount })}
              <button
                type="button"
                className="process-trace-show-all"
                onClick={() => setShowAllItems(true)}
              >
                {t('trace.showAllItems', { count: processItems.length })}
              </button>
            </div>
          )}
          {visibleProcessItems.map((item) => item.type === 'thinking' ? (
            <ThinkingTimelineItem
              key={item.id}
              content={item.content}
              active={running && item === lastProcessItem}
              lastThinking={item === lastThinkingItem}
              elapsedMs={durationMilliseconds(
                item.startedAt,
                running && item === lastProcessItem ? now : item.endedAt,
              ) ?? undefined}
              duration={formatDuration(
                durationMilliseconds(
                  item.startedAt,
                  running && item === lastProcessItem ? now : item.endedAt,
                ) ?? Number.NaN,
                t,
              )}
            />
          ) : item.type === 'commentary' ? (
            <MarkdownMessage
              key={item.id}
              content={item.content}
              streaming={running && item === lastProcessItem}
              projectId={projectId}
            />
          ) : item.type === 'subagent' ? (
            <SubagentTimelineItem
              key={item.id}
              item={item}
              lastSubagent={item === lastSubagentItem}
              messageRunning={running}
              projectId={projectId}
            />
          ) : (
            <ToolTimelineItem key={item.id} item={item} streaming={running} projectId={projectId} />
          ))}
        </div>
        )}
      </div>
    </div>
  )
}
