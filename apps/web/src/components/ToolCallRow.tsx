import { useMemo, useState } from 'react'
import Icon, { type IconName } from './Icon'
import { MessageCopyButton } from './MessageResponseFooter'
import FilePreviewDialog from './FilePreviewDialog'
import { useI18n, type TFunction } from '../i18n'
import { durationMilliseconds, formatDuration } from '../utils/datetime'
import type { ToolActivity } from '../utils/messageTimeline'
import { extractToolTarget, type ToolTargetInfo } from '../utils/toolInput'
import { classifyProjectFileLink, type ProjectFileLink } from '../utils/markdownFilePreview'

type ToolKind = 'edit' | 'read' | 'command' | 'search' | 'subagent' | 'other'

/**
 * 展开时单段（输入/结果）显示上限。子代理一次读取/编辑的 raw_output 可达数十 MB，
 * 全量 JSON.stringify + 塞进 DOM 会冻结主线程（折叠时也照渲染，因为 <details>
 * 只是 CSS 隐藏）。超限即截断；完整内容应由后端按需提供（per-event 拉取）。
 */
const MAX_DETAIL_CHARS = 50_000

/** 仅在展开时调用：把工具输入/结果转为可显示文本并截断，避免渲染期 stringify 巨串。 */
function cappedText(value: unknown): { text: string; truncated: boolean } {
  if (value === undefined || value === null) return { text: '', truncated: false }
  if (typeof value === 'string') {
    return value.length > MAX_DETAIL_CHARS
      ? { text: value.slice(0, MAX_DETAIL_CHARS), truncated: true }
      : { text: value, truncated: false }
  }
  try {
    const s = JSON.stringify(value, null, 2)
    return s.length > MAX_DETAIL_CHARS
      ? { text: s.slice(0, MAX_DETAIL_CHARS), truncated: true }
      : { text: s, truncated: false }
  } catch {
    return { text: String(value), truncated: false }
  }
}

/**
 * 工具详情（输入/结果）——只在 <details> 展开时挂载。
 * 折叠状态下完全不计算/不渲染这段，巨型 raw_output 因此不会拖垮每次渲染。
 */
function ToolCallDetail({ input, result, t }: {
  input: unknown
  result: unknown
  t: TFunction
}) {
  const inputText = useMemo(() => cappedText(input), [input])
  const resultText = useMemo(() => cappedText(result), [result])
  const truncatedHint = (
    <div className="process-trace-empty">
      {t('trace.outputTruncated', { count: MAX_DETAIL_CHARS })}
    </div>
  )
  return (
    <div className="llm-tool-call-detail">
      {inputText.text && (
        <div className="llm-tool-call-section">
          <div className="llm-tool-call-section-header">
            <span>{t('trace.input')}</span>
            <MessageCopyButton content={inputText.text} title={t('trace.copyInput')} />
          </div>
          <pre>{inputText.text}</pre>
          {inputText.truncated && truncatedHint}
        </div>
      )}
      {resultText.text && (
        <div className="llm-tool-call-section">
          <div className="llm-tool-call-section-header">
            <span>{t('trace.result')}</span>
            <MessageCopyButton content={resultText.text} title={t('trace.copyResult')} />
          </div>
          <pre>{resultText.text}</pre>
          {resultText.truncated && truncatedHint}
        </div>
      )}
      {!inputText.text && !resultText.text && (
        <div className="process-trace-empty">{t('trace.noDetails')}</div>
      )}
    </div>
  )
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

function completedSummary(
  activity: ToolActivity,
  t: TFunction,
  fileLink: ProjectFileLink | null,
  info: ToolTargetInfo,
): string {
  const kind = toolKind(activity.name)
  // 文件目标（path 系键）与搜索目标（pattern / query）分列：读取/编辑的
  // pattern 只是过滤关键词（如 read_tool_result 的 pattern:"fail"），
  // 绝不能当作文件名展示。
  const fileTargetName = info.fileTarget ? ` ${basename(info.fileTarget)}` : ''
  const searchTargetName = info.searchTarget ? ` ${info.searchTarget}` : ''
  if (kind === 'subagent') return t('trace.calledSubagent')
  // 文件名以独立的可点击文件链接呈现时，摘要只保留动词，避免文件名重复出现。
  const fileTarget = fileLink ? '' : fileTargetName || t('trace.file')
  if (kind === 'edit') return t('trace.edited', { target: fileTarget }).trim()
  if (kind === 'read') return t('trace.read', { target: fileTarget }).trim()
  if (kind === 'command') return t('trace.ranCommand')
  if (kind === 'search') return t('trace.searched', { target: searchTargetName }).trim()
  return t('trace.calledTool', { name: activity.name || t('chat.tool') })
}

interface ToolCallRowProps {
  activity: ToolActivity
  messageRunning?: boolean
  now?: number
  /** 项目 id：把 read/edit 工具目标解析为可预览的项目文件链接。 */
  projectId?: string
}

export default function ToolCallRow({
  activity,
  messageRunning = false,
  now = Date.now(),
  projectId,
}: ToolCallRowProps) {
  const { t } = useI18n()
  const [previewFile, setPreviewFile] = useState<ProjectFileLink | null>(null)
  // 详情（输入/结果）仅在展开后挂载：折叠时完全不碰可能达数十 MB 的 raw_output，
  // 否则流式期间每次重渲染都会 stringify 巨串并塞进 DOM，主线程被占满、页面失去响应。
  const [open, setOpen] = useState(false)
  const isRunning = messageRunning && !activity.hasResult
  const kind = toolKind(activity.name)
  const targetInfo = extractToolTarget(activity.input)
  // 读取/编辑目标渲染为 Markdown 风格的文件名链接（复用消息组件的文件预览逻辑）；
  // 执行中也立即呈现——只要目标值本身已完整（完整对象 / 完整 JSON / 截断 JSON
  // 中已闭合的路径字符串），就不必等工具结束，避免右侧长时间缺少文件名。
  // 失败的读取/编辑不渲染链接：文件可能不存在或写入失败，预览无意义；
  // 摘要中的文件名文本与失败标记仍然保留，便于定位。
  // 文件名链接只取文件目标（path 系键）；pattern/query 是搜索/过滤关键词，
  // 即便出现在读取类工具（如 read_tool_result）里也不能当文件渲染。
  const fileLink = !activity.isError
    && (kind === 'read' || kind === 'edit')
    && targetInfo.fileTarget
    && targetInfo.targetComplete
    ? classifyProjectFileLink(targetInfo.fileTarget, projectId)
    : null
  const summary = isRunning
    ? t('chat.toolRunning', { name: activity.name || t('chat.tool') })
    : completedSummary(activity, t, fileLink, targetInfo)
  const endedAt = activity.endedAt ?? (isRunning ? now : undefined)
  const duration = formatDuration(
    durationMilliseconds(activity.startedAt, endedAt) ?? Number.NaN,
    t,
  )
  const previewTitle = fileLink ? t('md.previewFile', { name: fileLink.name }) : ''

  return (
    <details
      className={`llm-tool-call llm-tool-call-${isRunning ? 'running' : activity.isError ? 'failed' : 'done'}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        title={targetInfo.target || undefined}
        onClick={(event) => {
          // 文件名渲染为非交互 span（交互元素放进 <summary> 会触发可访问性
          // 告警且键盘行为不一致），点击经此委托：命中文件名 → 打开预览并
          // preventDefault 阻止本次展开/折叠；键盘入口在展开后的详情里。
          if (fileLink && (event.target as HTMLElement).closest('[data-file-preview-link]')) {
            event.preventDefault()
            setPreviewFile(fileLink)
          }
        }}
      >
        <span className="llm-tool-call-icon" aria-hidden="true">
          <Icon name={toolIcon(kind)} size={13} strokeWidth={1.7} />
        </span>
        <span className={`llm-tool-call-summary${isRunning ? ' is-shimmer' : ''}`}>
          {summary}
          {duration && t('trace.commandDuration', { duration })}
        </span>
        {fileLink && (
          <span
            className="markdown-file-link"
            data-file-preview="true"
            data-file-preview-link="true"
            title={previewTitle}
            aria-label={previewTitle}
            style={{ cursor: 'pointer' }}
          >
            {fileLink.name}
          </span>
        )}
        {activity.isError && <span className="process-trace-error">{t('trace.failed')}</span>}
        <Icon name="chevron-down" size={12} strokeWidth={1.8} className="llm-tool-call-chevron" />
      </summary>
      {open && (
        <ToolCallDetail
          input={activity.input}
          result={activity.result}
          t={t}
        />
      )}
      {previewFile && projectId && (
        <FilePreviewDialog
          path={previewFile.path}
          name={previewFile.name}
          line={previewFile.line}
          projectId={projectId}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </details>
  )
}
