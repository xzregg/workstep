import { useState } from 'react'
import Icon, { type IconName } from './Icon'
import { MessageCopyButton } from './MessageResponseFooter'
import FilePreviewDialog from './FilePreviewDialog'
import { useI18n, type TFunction } from '../i18n'
import type { ToolActivity } from '../utils/messageTimeline'
import { extractToolTarget, type ToolTargetInfo } from '../utils/toolInput'
import { classifyProjectFileLink, type ProjectFileLink } from '../utils/markdownFilePreview'

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
  /** 项目 id：把 read/edit 工具目标解析为可预览的项目文件链接。 */
  projectId?: string
}

export default function ToolCallRow({
  activity,
  messageRunning = false,
  projectId,
}: ToolCallRowProps) {
  const { t } = useI18n()
  const [previewFile, setPreviewFile] = useState<ProjectFileLink | null>(null)
  const input = textValue(activity.input)
  const result = textValue(activity.result)
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
  const previewTitle = fileLink ? t('md.previewFile', { name: fileLink.name }) : ''

  return (
    <details className={`llm-tool-call llm-tool-call-${isRunning ? 'running' : activity.isError ? 'failed' : 'done'}`}>
      <summary title={targetInfo.target || undefined}>
        <span className="llm-tool-call-icon" aria-hidden="true">
          <Icon name={toolIcon(kind)} size={13} strokeWidth={1.7} />
        </span>
        <span className={`llm-tool-call-summary${isRunning ? ' is-shimmer' : ''}`}>{summary}</span>
        {fileLink && (
          <a
            className="markdown-file-link"
            role="button"
            tabIndex={0}
            data-file-preview="true"
            title={previewTitle}
            aria-label={previewTitle}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setPreviewFile(fileLink)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              setPreviewFile(fileLink)
            }}
          >
            {fileLink.name}
          </a>
        )}
        {activity.isError && <span className="process-trace-error">{t('trace.failed')}</span>}
        <Icon name="chevron-down" size={12} strokeWidth={1.8} className="llm-tool-call-chevron" />
      </summary>
      <div className="llm-tool-call-detail">
        {input && (
          <div className="llm-tool-call-section">
            <div className="llm-tool-call-section-header">
              <span>{t('trace.input')}</span>
              <MessageCopyButton content={input} title={t('trace.copyInput')} />
            </div>
            <pre>{input}</pre>
          </div>
        )}
        {result && (
          <div className="llm-tool-call-section">
            <div className="llm-tool-call-section-header">
              <span>{t('trace.result')}</span>
              <MessageCopyButton content={result} title={t('trace.copyResult')} />
            </div>
            <pre>{result}</pre>
          </div>
        )}
        {!input && !result && <div className="process-trace-empty">{t('trace.noDetails')}</div>}
      </div>
      {previewFile && projectId && (
        <FilePreviewDialog
          path={previewFile.path}
          name={previewFile.name}
          projectId={projectId}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </details>
  )
}
