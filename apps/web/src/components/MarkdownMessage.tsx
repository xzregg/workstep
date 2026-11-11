import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectFileLink } from '../utils/markdownFilePreview'
import FilePreviewDialog from './FilePreviewDialog'
import ImagePreview from './ImagePreview'
import MarkdownContent from './MarkdownContent'
import useStreamReveal from '../hooks/useStreamReveal'
import { useTaskFilePreview } from '../contexts/MarkdownAssetUrlContext'
import { useActiveSkin } from '../skins/runtime'

interface MarkdownMessageProps {
  content: string
  streaming?: boolean
  /**
   * 流式文字揭示动画模式。
   * - 'a'（默认）：跟随 token 到达快速揭示（帧率 ≤ token 频率，无额外重渲染开销），
   *   新字以 90ms 模糊淡入、相邻字错开 30ms，形成晕染观感
   * - 'off'：关闭揭示层，渲染结果与历史版本完全一致（回退开关）
   * compactParagraphs（嵌套时间线）场景由调用方决定是否传入。
   */
  reveal?: 'a' | 'off'
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
  /** Mermaid render delay; use 0 for complete, non-streaming file content. */
  mermaidRenderDelayMs?: number
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
  mermaidRenderDelayMs,
  onImageClick,
  reveal = 'a',
}: MarkdownMessageProps) {
  const [previewFile, setPreviewFile] = useState<ProjectFileLink | null>(null)
  const taskFilePreview = useTaskFilePreview()
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const freshStream = useRef(streaming && content.length === 0)
  const effects = useActiveSkin().effects
  const latestRenderRef = useRef({ content, streaming })
  latestRenderRef.current = { content, streaming }
  const [selectionSnapshot, setSelectionSnapshot] = useState<{
    content: string
    streaming: boolean
  } | null>(null)
  const watchSelection = streaming || selectionSnapshot !== null

  useEffect(() => {
    // 选区释放会全量追平，不把追平的文字再次当作新流播放。
    if (selectionSnapshot !== null) freshStream.current = false
  }, [selectionSnapshot])

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
  // 揭示层挂在选区快照之后：冻结期间输入是快照（不变），释放时 hook 检测到
  // frozen true→false 立即全量追平，选区冻结语义原样保留。
  const revealedContent = useStreamReveal(
    renderedContent,
    renderedStreaming,
    selectionSnapshot !== null,
    reveal === 'a' && !plainText,
  )
  const handleFileClick = useCallback((file: ProjectFileLink) => setPreviewFile(file), [])
  const handleImageClick = useCallback((src: string, alt: string) => {
    if (onImageClick) onImageClick(src, alt)
    else setPreviewImage({ src, alt })
  }, [onImageClick])

  return (
    <>
      <MarkdownContent
        content={revealedContent}
        animateReveal={freshStream.current && reveal === 'a' && !plainText && effects?.reveal !== false && selectionSnapshot === null && (renderedStreaming || revealedContent !== renderedContent)}
        streaming={renderedStreaming}
        projectId={projectId}
        className={className}
        compactParagraphs={compactParagraphs}
        plainText={plainText}
        mermaidRenderDelayMs={mermaidRenderDelayMs}
        onImageClick={handleImageClick}
        onFileClick={handleFileClick}
        rootRef={rootRef}
      />
      {previewFile && (projectId || taskFilePreview) && (
        <FilePreviewDialog
          path={previewFile.path}
          name={previewFile.name}
          line={previewFile.line}
          projectId={projectId}
          onClose={() => setPreviewFile(null)}
        />
      )}
      {previewImage && (
        <ImagePreview
          src={previewImage.src}
          alt={previewImage.alt}
          projectId={projectId}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </>
  )
}

export default memo(MarkdownMessage)
