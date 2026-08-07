import { useEffect, useRef, useState } from 'react'
import { MessageCopyButton } from './MessageResponseFooter'
import {
  durationMilliseconds,
  formatDuration,
  toMilliseconds,
  type DateTimeValue,
} from '../utils/datetime'

type ProcessEvent = {
  type: string
  data?: Record<string, unknown>
  timestamp?: DateTimeValue
}

type ToolActivity = {
  id: string
  name: string
  input?: unknown
  result?: unknown
  isError?: boolean
}

interface ProcessTraceProps {
  events: ProcessEvent[]
  running?: boolean
  /** 该条 LLM 消息被手动停止（summary 显示“在 X 后停止了”）。 */
  stopped?: boolean
  startedAt?: DateTimeValue
  endedAt?: DateTimeValue
  compact?: boolean
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object'
    ? input as Record<string, unknown>
    : {}
}

function toolTarget(activity: ToolActivity): string {
  const input = inputRecord(activity.input)
  const value = (
    input.path
    ?? input.file_path
    ?? input.filePath
    ?? input.filename
    ?? input.pattern
    ?? input.query
  )
  return typeof value === 'string' ? value : ''
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function toolKind(name: string): 'edit' | 'read' | 'command' | 'search' | 'subagent' | 'other' {
  const normalized = name.toLowerCase()
  if (/(subagent|sub-agent|sub_agent|spawn_agent|spawn.*agent|delegate)/.test(normalized)) return 'subagent'
  if (/(edit|write|patch|replace|create)/.test(normalized)) return 'edit'
  if (/(read|open|view)/.test(normalized)) return 'read'
  if (/(bash|shell|command|exec|terminal)/.test(normalized)) return 'command'
  if (/(grep|glob|search|find|list)/.test(normalized)) return 'search'
  return 'other'
}

function toolIcon(kind: ReturnType<typeof toolKind>): string {
  if (kind === 'subagent') return '🤖'
  if (kind === 'edit') return '✎'
  if (kind === 'read') return '▤'
  if (kind === 'command') return '›_'
  if (kind === 'search') return '⌕'
  return '◇'
}

function toolSummary(activity: ToolActivity): string {
  const kind = toolKind(activity.name)
  const target = toolTarget(activity)
  const targetName = target ? ` ${basename(target)}` : ''
  if (kind === 'subagent') return '已调用子代理'
  if (kind === 'edit') return `已编辑${targetName || '文件'}`
  if (kind === 'read') return `已读取${targetName || '文件'}`
  if (kind === 'command') return '已运行命令'
  if (kind === 'search') return `已搜索${targetName}`
  return `已调用 ${activity.name || '工具'}`
}

function groupSummary(activities: ToolActivity[]): string {
  const kinds = new Set(activities.map((activity) => toolKind(activity.name)))
  const labels: string[] = []
  if (kinds.has('subagent')) labels.push('调用了子代理')
  if (kinds.has('edit')) labels.push('编辑了文件')
  if (kinds.has('read')) labels.push('读取了文件')
  if (kinds.has('command')) labels.push('运行了命令')
  if (kinds.has('search')) labels.push('进行了搜索')
  if (kinds.has('other')) labels.push('调用了工具')
  return labels.join('、') || `工具调用 ${activities.length} 项`
}

function collectTools(events: ProcessEvent[]): ToolActivity[] {
  const activities: ToolActivity[] = []
  const byId = new Map<string, ToolActivity>()

  events.forEach((event, index) => {
    const data = event.data || {}
    if (event.type === 'tool_use') {
      const id = String(data.id || `tool-${index}`)
      const activity: ToolActivity = {
        id,
        name: String(data.name || '工具'),
        input: data.input,
      }
      activities.push(activity)
      byId.set(id, activity)
      return
    }

    if (event.type === 'tool_result') {
      const id = String(data.tool_use_id || data.id || '')
      const activity = byId.get(id)
      if (activity) {
        activity.result = data.content ?? data.result
        activity.isError = Boolean(data.is_error)
      } else {
        activities.push({
          id: id || `result-${index}`,
          name: String(data.name || '工具结果'),
          result: data.content ?? data.result,
          isError: Boolean(data.is_error),
        })
      }
    }
  })

  return activities
}

export default function ProcessTrace({
  events,
  running = false,
  stopped = false,
  startedAt,
  endedAt,
  compact = false,
}: ProcessTraceProps) {
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])
  useEffect(() => {
    if (!open || !compact || !containerRef.current) return
    const panel = bodyRef.current
    if (!panel) return
    // 找到最近的可滚动祖先（消息列表），浮层展开或内部折叠展开后不能被外层遮住。
    const revealPanel = () => {
      let scroller: HTMLElement | null = containerRef.current?.parentElement ?? null
      while (scroller) {
        const overflowY = getComputedStyle(scroller).overflowY
        if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') break
        scroller = scroller.parentElement
      }
      if (!scroller) return
      const panelRect = panel.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const bottomOverflow = panelRect.bottom - (scrollerRect.bottom - 12)
      const topOverflow = (scrollerRect.top + 12) - panelRect.top
      if (bottomOverflow > 0) {
        scroller.scrollTop += bottomOverflow
      } else if (topOverflow > 0) {
        scroller.scrollTop -= topOverflow
      }
    }
    revealPanel()
    const observer = new ResizeObserver(() => revealPanel())
    observer.observe(panel)
    return () => observer.disconnect()
  }, [open, compact])

  const thinking = events
    .filter((event) => event.type === 'thinking_delta')
    .map((event) => textValue(event.data?.delta ?? event.data?.text))
    .join('')
    .trim()
  const activities = collectTools(events)
  const eventTimes = events
    .map((event) => toMilliseconds(event.timestamp))
    .filter((timestamp): timestamp is number => timestamp !== null)
  const startTime = toMilliseconds(startedAt)
    ?? (eventTimes.length ? Math.min(...eventTimes) : null)
  const endTime = running
    ? now
    : toMilliseconds(endedAt)
      ?? (eventTimes.length ? Math.max(...eventTimes) : null)
  const elapsedMs = durationMilliseconds(startTime, endTime)
  const duration = elapsedMs === null ? '' : formatDuration(elapsedMs)

  if (!duration && !thinking && activities.length === 0) return null

  return (
    <div
      ref={containerRef}
      className={`process-trace${compact ? ' process-trace-compact' : ''}`}
    >
      <details
        className="process-trace-session"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <span>
            {running ? '处理中' : '已处理'}
            {!running && stopped
              ? (duration ? ` · 在 ${duration} 后停止了` : ' · 已停止')
              : (duration ? ` ${duration}` : '')}
          </span>
          <span className="process-trace-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div ref={bodyRef} className="process-trace-body">
          {thinking && (
            <div className="process-trace-thinking-block">
              <div className="process-trace-section-title">
                <span className="process-trace-summary-icon" aria-hidden="true">◌</span>
                <span>思考过程</span>
                <span style={{ marginLeft: 'auto' }}>
                  <MessageCopyButton content={thinking} title="复制思考过程" />
                </span>
              </div>
              <div className="process-trace-thinking">{thinking}</div>
            </div>
          )}

          {activities.length > 0 && (
            <details className="process-trace-tools-group">
              <summary className="process-trace-section-title">
                <span className="process-trace-summary-icon" aria-hidden="true">◇</span>
                <span>{groupSummary(activities)}</span>
                <span className="process-trace-count">{activities.length} 项</span>
                <span className="process-trace-chevron" aria-hidden="true">⌄</span>
              </summary>
              <div className="process-trace-tools">
                {activities.map((activity) => {
                  const input = textValue(activity.input)
                  const result = textValue(activity.result)
                  const kind = toolKind(activity.name)
                  return (
                    <details className="process-trace-tool" key={activity.id}>
                      <summary>
                        <span className="process-trace-tool-icon" aria-hidden="true">
                          {toolIcon(kind)}
                        </span>
                        <span>{toolSummary(activity)}</span>
                        {activity.isError && <span className="process-trace-error">失败</span>}
                        <span className="process-trace-chevron" aria-hidden="true">⌄</span>
                      </summary>
                      <div className="process-trace-tool-detail">
                        {input && (
                          <div>
                            <span>输入</span>
                            <pre>{input}</pre>
                          </div>
                        )}
                        {result && (
                          <div>
                            <span>结果</span>
                            <pre>{result}</pre>
                          </div>
                        )}
                        {!input && !result && (
                          <div className="process-trace-empty">暂无详情</div>
                        )}
                      </div>
                    </details>
                  )
                })}
              </div>
            </details>
          )}
        </div>
      </details>
    </div>
  )
}
