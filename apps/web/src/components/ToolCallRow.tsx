import Icon, { type IconName } from './Icon'
import { useI18n, type TFunction } from '../i18n'
import type { ToolActivity } from '../utils/messageTimeline'

type ToolKind = 'edit' | 'read' | 'command' | 'search' | 'subagent' | 'other'

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

function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase()
  if (/(subagent|sub-agent|sub_agent|spawn_agent|spawn.*agent|delegate)/.test(normalized)) return 'subagent'
  if (/(edit|write|patch|replace|create)/.test(normalized)) return 'edit'
  if (/(read|open|view)/.test(normalized)) return 'read'
  if (/(bash|shell|command|exec|terminal)/.test(normalized)) return 'command'
  if (/(grep|glob|search|find|list)/.test(normalized)) return 'search'
  return 'other'
}

function toolIcon(kind: ToolKind): IconName {
  if (kind === 'subagent') return 'bot'
  if (kind === 'edit') return 'pencil'
  if (kind === 'read') return 'file'
  if (kind === 'command') return 'terminal'
  if (kind === 'search') return 'search'
  return 'sparkles'
}

function completedSummary(activity: ToolActivity, t: TFunction): string {
  const kind = toolKind(activity.name)
  const target = toolTarget(activity)
  const targetName = target ? ` ${basename(target)}` : ''
  if (kind === 'subagent') return t('trace.calledSubagent')
  if (kind === 'edit') return t('trace.edited', { target: targetName || t('trace.file') })
  if (kind === 'read') return t('trace.read', { target: targetName || t('trace.file') })
  if (kind === 'command') return t('trace.ranCommand')
  if (kind === 'search') return t('trace.searched', { target: targetName })
  return t('trace.calledTool', { name: activity.name || t('chat.tool') })
}

interface ToolCallRowProps {
  activity: ToolActivity
  messageRunning?: boolean
}

export default function ToolCallRow({
  activity,
  messageRunning = false,
}: ToolCallRowProps) {
  const { t } = useI18n()
  const input = textValue(activity.input)
  const result = textValue(activity.result)
  const isRunning = messageRunning && !activity.hasResult
  const kind = toolKind(activity.name)
  const summary = isRunning
    ? t('chat.toolRunning', { name: activity.name || t('chat.tool') })
    : completedSummary(activity, t)

  return (
    <details className={`llm-tool-call llm-tool-call-${isRunning ? 'running' : activity.isError ? 'failed' : 'done'}`}>
      <summary title={toolTarget(activity) || undefined}>
        <span className="llm-tool-call-icon" aria-hidden="true">
          <Icon name={toolIcon(kind)} size={13} strokeWidth={1.7} />
        </span>
        <span className={`llm-tool-call-summary${isRunning ? ' is-shimmer' : ''}`}>{summary}</span>
        {activity.isError && <span className="process-trace-error">{t('trace.failed')}</span>}
        <Icon name="chevron-down" size={12} strokeWidth={1.8} className="llm-tool-call-chevron" />
      </summary>
      <div className="llm-tool-call-detail">
        {input && (
          <div>
            <span>{t('trace.input')}</span>
            <pre>{input}</pre>
          </div>
        )}
        {result && (
          <div>
            <span>{t('trace.result')}</span>
            <pre>{result}</pre>
          </div>
        )}
        {!input && !result && <div className="process-trace-empty">{t('trace.noDetails')}</div>}
      </div>
    </details>
  )
}
