import { useEffect, useState } from 'react'
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

function toolKind(name: string): 'edit' | 'read' | 'command' | 'search' | 'other' {
  const normalized = name.toLowerCase()
  if (/(edit|write|patch|replace|create)/.test(normalized)) return 'edit'
  if (/(read|open|view)/.test(normalized)) return 'read'
  if (/(bash|shell|command|exec|terminal)/.test(normalized)) return 'command'
  if (/(grep|glob|search|find|list)/.test(normalized)) return 'search'
  return 'other'
}

function toolIcon(kind: ReturnType<typeof toolKind>): string {
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
  if (kind === 'edit') return `已编辑${targetName || '文件'}`
  if (kind === 'read') return `已读取${targetName || '文件'}`
  if (kind === 'command') return '已运行命令'
  if (kind === 'search') return `已搜索${targetName}`
  return `已调用 ${activity.name || '工具'}`
}

function groupSummary(activities: ToolActivity[]): string {
  const kinds = new Set(activities.map((activity) => toolKind(activity.name)))
  const labels: string[] = []
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
  startedAt,
  endedAt,
  compact = false,
}: ProcessTraceProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

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
    <div className={`process-trace${compact ? ' process-trace-compact' : ''}`}>
      <details className="process-trace-session">
        <summary>
          <span>{running ? '处理中' : '已处理'}{duration ? ` ${duration}` : ''}</span>
          <span className="process-trace-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div className="process-trace-body">
          {thinking && (
            <div className="process-trace-thinking-block">
              <div className="process-trace-section-title">
                <span className="process-trace-summary-icon" aria-hidden="true">◌</span>
                <span>思考过程</span>
              </div>
              <div className="process-trace-thinking">{thinking}</div>
            </div>
          )}

          {activities.length > 0 && (
            <div className="process-trace-tools-block">
              <div className="process-trace-section-title">
                <span className="process-trace-summary-icon" aria-hidden="true">◇</span>
                <span>{groupSummary(activities)}</span>
                <span className="process-trace-count">{activities.length} 项</span>
              </div>
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
            </div>
          )}
        </div>
      </details>
    </div>
  )
}
