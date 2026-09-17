import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectFileLink } from '../utils/markdownFilePreview'
import FilePreviewDialog from './FilePreviewDialog'
import MarkdownContent from './MarkdownContent'

interface MarkdownMessageProps {
  content: string
  streaming?: boolean
  /** Project id used to resolve `.workstep/uploads/...` relative image paths. */
  projectId?: string
  className?: string
  /** Render paragraphs as compact blocks for nested process/event timelines. */
  compactParagraphs?: boolean
  /**
   * Treat the content as literal text: a typed newline stays a normal-height
   * line break and Markdown block syntax (`#`, `-`, blank lines, …) is never
   * parsed into `<p>`/`<li>`/headings. Only inline image (`![]()`) and link
   * (`[]()`) syntax are honoured, so user chat bubbles keep showing uploaded
   * attachments while reading like plain text.
   */
  plainText?: boolean
  /** When set, images render as clickable thumbnails calling this with (src, alt). */
  onImageClick?: (src: string, alt: string) => void
}

/**
 * memo 化：markdown 解析 + 代码高亮是单条消息里最重的渲染。流式输出时父级
 * （消息列表/任务详情）每个 token 都会重渲染，历史消息的 content 字符串不变，
 * 靠 memo 按值比较直接跳过整棵解析子树。
 */
function MarkdownMessage({
  content,
  streaming = false,
  projectId,
  className,
  compactParagraphs = false,
  plainText = false,
  onImageClick,
}: MarkdownMessageProps) {
  const [previewFile, setPreviewFile] = useState<ProjectFileLink | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const latestRenderRef = useRef({ content, streaming })
  latestRenderRef.current = { content, streaming }
  const [selectionSnapshot, setSelectionSnapshot] = useState<{
    content: string
    streaming: boolean
  } | null>(null)
  const watchSelection = streaming || selectionSnapshot !== null

  useEffect(() => {
    if (!watchSelection) return
    const ownerDocument = rootRef.current?.ownerDocument
    if (!ownerDocument) return
    const handleSelectionChange = () => {
      const root = rootRef.current
      const selection = ownerDocument.getSelection()
      const anchor = selection?.anchorNode
      const focus = selection?.focusNode
      const selectedInside = Boolean(
        root && selection && !selection.isCollapsed
        && ((anchor && root.contains(anchor)) || (focus && root.contains(focus))),
      )
      setSelectionSnapshot((current) => {
        if (selectedInside) return current ?? latestRenderRef.current
        return null
      })
    }
    ownerDocument.addEventListener('selectionchange', handleSelectionChange)
    return () => ownerDocument.removeEventListener('selectionchange', handleSelectionChange)
  }, [watchSelection])

  const renderedContent = selectionSnapshot?.content ?? content
  const renderedStreaming = selectionSnapshot?.streaming ?? streaming
  const handleFileClick = useCallback((file: ProjectFileLink) => setPreviewFile(file), [])

  return (
    <>
      <MarkdownContent
        content={renderedContent}
        streaming={renderedStreaming}
        projectId={projectId}
        className={className}
        compactParagraphs={compactParagraphs}
        plainText={plainText}
        onImageClick={onImageClick}
        onFileClick={handleFileClick}
        rootRef={rootRef}
      />
      {previewFile && projectId && (
        <FilePreviewDialog
          path={previewFile.path}
          name={previewFile.name}
          line={previewFile.line}
          projectId={projectId}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </>
  )
}

export default memo(MarkdownMessage)
