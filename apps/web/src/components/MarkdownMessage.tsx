import SmoothMessageHeight from './SmoothMessageHeight'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectFileLink } from '../utils/markdownFilePreview'
import FilePreviewDialog from './FilePreviewDialog'
import ImagePreview, { type ImagePreviewGallery } from './ImagePreview'
import MarkdownContent from './MarkdownContent'
import useStreamReveal from '../hooks/useStreamReveal'
import { REVEAL_SETTLE_MS } from './StreamRevealText'
import { useTaskFilePreview } from '../contexts/MarkdownAssetUrlContext'
import { useActiveSkin } from '../skins/runtime'

interface MarkdownMessageProps {
  content: string
  /** Enable source-positioned prose editing inside the existing preview. */
  editableText?: boolean
  streaming?: boolean
  /** A new live timeline block, rather than a restored nonempty message. */
  revealInitial?: boolean
  /**
   * 流式文字揭示动画模式。
   * - 'a'（默认）：跟随 token 到达快速揭示（帧率 ≤ token 频率，无额外重渲染开销），
   *   新字按批内90ms错峰依次清晰显示，保持正文稳定
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
}

/**
 * memo 化：markdown 解析 + 代码高亮是单条消息里最重的渲染。流式输出时父级
 * （消息列表/任务详情）每个 token 都会重渲染，历史消息的 content 字符串不变，
 * 靠 memo 按值比较直接跳过整棵解析子树。
 */
function MarkdownMessage({
  content: rawContent,
  streaming = false,
  revealInitial = false,
  projectId,
  className,
  compactParagraphs = false,
  plainText = false,
  mermaidRenderDelayMs,
  reveal = 'a',
  editableText = false,
}: MarkdownMessageProps) {
  const content = rawContent ?? ''
  const [previewFile, setPreviewFile] = useState<ProjectFileLink | null>(null)
  const taskFilePreview = useTaskFilePreview()
  const [imageGallery, setImageGallery] = useState<ImagePreviewGallery | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const animateInitialReveal = useRef(revealInitial || content.length === 0)
  const selectionResumeContent = useRef<string | null>(null)
  const effects = useActiveSkin().effects
  const latestRenderRef = useRef({ content, streaming })
  latestRenderRef.current = { content, streaming }
  const [selectionSnapshot, setSelectionSnapshot] = useState<{
    content: string
    streaming: boolean
  } | null>(null)
  const watchSelection = streaming || selectionSnapshot !== null

  useEffect(() => {
    // Existing text is a baseline, even when the component first mounts after
    // the first token. Later appended text and new paragraphs may still bloom.
    // New nodes revealed when a selection is released start without animation.
    animateInitialReveal.current = selectionSnapshot === null
  }, [content, selectionSnapshot])

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
      if (!selectedInside) selectionResumeContent.current = latestRenderRef.current.content
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
    revealInitial,
  )
  const revealing = renderedStreaming || revealedContent !== renderedContent
  const [settling, setSettling] = useState(streaming)
  useEffect(() => {
    if (revealing) { setSettling(true); return }
    if (!settling) return
    const timer = setTimeout(() => setSettling(false), REVEAL_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [revealing, revealedContent, settling])
  const handleFileClick = useCallback((file: ProjectFileLink) => setPreviewFile(file), [])
  const handleImageClick = useCallback((selected: HTMLButtonElement) => {
    // Snapshot the rendered thumbnails in reading order, including duplicate URLs.
    const buttons = Array.from(rootRef.current!.querySelectorAll<HTMLButtonElement>('.markdown-image-click[data-image-src]'))
    setImageGallery({
      images: buttons.map(button => ({ src: button.dataset.imageSrc!, alt: button.querySelector('img')?.alt })),
      initialIndex: buttons.indexOf(selected),
    })
  }, [])

  return (
    <>
      <SmoothMessageHeight active={revealing || settling}>
      <MarkdownContent
        editableText={editableText}
        content={revealedContent}
        animateReveal={reveal === 'a' && !plainText && effects?.reveal !== false && (revealing || settling) && selectionResumeContent.current !== renderedContent}
        animateInitialReveal={animateInitialReveal.current}
        freezeReveal={selectionSnapshot !== null}
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
      </SmoothMessageHeight>
      {previewFile && (projectId || taskFilePreview) && (
        <FilePreviewDialog
          path={previewFile.path}
          name={previewFile.name}
          line={previewFile.line}
          projectId={projectId}
          onClose={() => setPreviewFile(null)}
        />
      )}
      {imageGallery && (
        <ImagePreview
          gallery={imageGallery}
          projectId={projectId}
          onClose={() => setImageGallery(null)}
        />
      )}
    </>
  )
}

export default memo(MarkdownMessage)
