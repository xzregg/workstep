import Icon from './Icon'
import { copyMermaidPng } from '../utils/mermaidPng'
import ResizablePanel from './ResizablePanel'
import MobilePreviewImage from './MobilePreviewImage'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { copyText } from '../utils/clipboard'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { resolveMarkdownImageSrc } from '../utils/markdownImages'
import { useI18n } from '../i18n'
import { useMarkdownUrlResolver } from '../contexts/MarkdownAssetUrlContext'

/* ══════════════════════════════════════════
   ImagePreview — shared full-screen image
   preview (dark overlay + enlarged image +
   close button; Esc or backdrop click closes
   it). Used by the composer attach chips, the
   user message bubbles and the prompt viewer
   so every image click shows the same effect.
   ══════════════════════════════════════════ */

export interface ImagePreviewProps {
  /** Image source as stored (raw relative path or absolute URL). */
  src: string
  alt?: string
  /** Render a generated diagram with shared window, copy and download actions. */
  diagramSvg?: string
  /** Project id used to resolve `.workstep/uploads/...` relative paths. */
  projectId?: string
  onClose: () => void
}

async function imageToPng(src: string): Promise<Blob> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Unable to load image'))
    image.src = src
  })
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable')
  context.drawImage(image, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Unable to encode image')), 'image/png')
  })
}

export default function ImagePreview({ src, alt, projectId, diagramSvg, onClose }: ImagePreviewProps) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const markdownUrlResolver = useMarkdownUrlResolver()
  const resolved = diagramSvg ? src : markdownUrlResolver?.(src) ?? resolveMarkdownImageSrc(src, projectId)
  const [zoom, setZoom] = useState(1)
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    setZoom(1)
    setImageSize(null)
  }, [resolved])
  const desktopViewport = useRef<HTMLDivElement>(null)
  const zoomAnchor = useRef<{ x: number; y: number; ratioX: number; ratioY: number } | null>(null)

  useLayoutEffect(() => {
    const viewport = desktopViewport.current
    const anchor = zoomAnchor.current
    zoomAnchor.current = null
    if (!viewport || !anchor) return
    const rect = viewport.firstElementChild!.getBoundingClientRect()
    viewport.scrollLeft += rect.left + anchor.ratioX * rect.width - anchor.x
    viewport.scrollTop += rect.top + anchor.ratioY * rect.height - anchor.y
  }, [zoom])
  const [copying, setCopying] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [result, setResult] = useState<{ src: string; action: 'image' | 'address' | 'download'; key: Parameters<typeof t>[0] } | null>(null)

  const copy = async (kind: 'image' | 'address') => {
    if (copying) return
    setCopying(true)
    setResult(null)
    try {
      let ok = true
      if (kind === 'address') {
        ok = await copyText(new URL(resolved, document.baseURI).href)
      } else if (diagramSvg) {
        await copyMermaidPng(diagramSvg)
      } else {
        if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
          throw new Error('Image clipboard is unavailable')
        }
        // Keep clipboard writing within user activation, before image decoding finishes.
        const png = imageToPng(resolved)
        void png.catch(() => {}) // Writing can be rejected before conversion completes.
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      }
      setResult({ src: resolved, action: kind, key: ok ? 'common.copied' : 'meta.copyFailed' })
    } catch {
      setResult({ src: resolved, action: kind, key: 'meta.copyFailed' })
    } finally {
      setCopying(false)
    }
  }

  const download = async () => {
    if (downloading) return
    setDownloading(true)
    setResult(null)
    try {
      const source = new URL(resolved, document.baseURI)
      const path = source.searchParams.get('path') ?? decodeURIComponent(source.pathname)
      const filename = source.protocol === 'data:' || source.protocol === 'blob:'
        ? '' : path.split(/[\\/]/).pop() ?? ''
      // Native WebViews own the save picker. Keep the real URL (and its auth
      // parameters) and initiate the download synchronously with the user click.
      if ((window.WorkStepAndroid || window.WorkStepIOS) &&
          source.origin === window.location.origin && /^https?:$/.test(source.protocol)) {
        const link = document.createElement('a')
        link.href = source.href
        link.download = filename || 'image'
        document.body.appendChild(link)
        link.click()
        link.remove()
        return
      }
      const response = await fetch(resolved)
      if (!response.ok) throw new Error('Unable to download image')
      const blob = await response.blob()
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
        'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif' }[blob.type.split(';')[0]]
      const url = URL.createObjectURL(blob)
      try {
        const link = document.createElement('a')
        link.href = url
        link.download = filename.includes('.') ? filename : `image${extension ? '.' + extension : ''}`
        document.body.appendChild(link)
        link.click()
        link.remove()
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch {
      setResult({ src: resolved, action: 'download', key: 'md.imageDownloadFailed' })
    } finally {
      setDownloading(false)
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!result || result.action === 'download') return
    const timer = window.setTimeout(() => setResult(null), 2000)
    return () => window.clearTimeout(timer)
  }, [result])

  const copyLabel = (action: 'image' | 'address', key: 'md.copyImage' | 'md.copyImageAddress') => {
    const notice = result?.src === resolved && result.action === action ? t(result.key) : ''
    return <span className="image-preview-button-label">
      <span className={notice ? 'image-preview-button-label-hidden' : undefined}>{t(key)}</span>
      {notice && <span className="image-preview-button-result" role="status">{notice}</span>}
    </span>
  }

  const closeButton = (
    <button
      type="button"
      className="image-preview-close"
      aria-label={t('common.close')}
      title={compact ? undefined : t('common.close')}
      onClick={onClose}
    >
      <svg className="image-preview-close-glyph" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="16" />
        <path d="M11 11 21 21M21 11 11 21" />
      </svg>
    </button>
  )

  return createPortal(
    <div
      className={diagramSvg ? 'image-preview mermaid-preview' : 'image-preview'}
      role="dialog"
      aria-modal="true"
      aria-label={`${t('md.preview')}：${alt || t('md.image')}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <ResizablePanel className={diagramSvg ? 'image-preview-window mermaid-preview__viewport' : 'image-preview-window'} minWidth={280} minHeight={160}>
        {!compact && <div className="preview-drag-handle" data-dialog-drag-handle role="button" tabIndex={0} aria-label={t('taskDetail.dragWindowAria')} title={t('taskDetail.dragWindowTitle')} />}
        {!compact && <div className="image-preview-header">{closeButton}</div>}
        {compact && closeButton}
        {!compact ? <div className={diagramSvg ? 'mermaid-preview__scroll' : 'desktop-image-preview'} ref={desktopViewport}
          style={!diagramSvg && imageSize ? { width: imageSize.width, height: imageSize.height } : undefined}
          onDoubleClick={event => {
            const canvas = desktopViewport.current?.firstElementChild
            if (!canvas) return
            const rect = canvas.getBoundingClientRect()
            if (!rect.width || !rect.height) return
            event.preventDefault()
            zoomAnchor.current = {
              x: event.clientX, y: event.clientY,
              ratioX: (event.clientX - rect.left) / rect.width,
              ratioY: (event.clientY - rect.top) / rect.height,
            }
            setZoom(value => value > 1 ? 1 : 2)
          }}>
          {diagramSvg ? <div className="mermaid-preview__canvas" style={{ width: `${zoom * 100}%` }} dangerouslySetInnerHTML={{ __html: diagramSvg }} /> :
            <img src={resolved} alt={alt || t('md.image')} draggable={false}
              className={imageSize ? 'desktop-image-preview__scaled' : undefined}
              style={imageSize ? { width: imageSize.width * zoom, height: imageSize.height * zoom } : undefined}
              onLoad={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                if (rect.width && rect.height) setImageSize({ width: rect.width, height: rect.height })
              }} />}
        </div> : <MobilePreviewImage key={resolved} src={resolved} alt={alt || t('md.image')} />}
        <div className="image-preview-toolbar">
          {!compact && <>
            <button type="button" data-testid="mermaid-preview-zoom-out" aria-label={t('md.mermaidZoomOut')} disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}><Icon name="minus" size={15} /></button>
            <button type="button" data-testid="mermaid-preview-zoom-level" aria-label={t('md.mermaidZoomReset')} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
            <button type="button" data-testid="mermaid-preview-zoom-in" aria-label={t('md.mermaidZoomIn')} disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + 0.25))}><Icon name="plus" size={15} /></button>
          </>}

          <button type="button" aria-label={t('md.copyImage')} disabled={copying} onClick={() => void copy('image')}>
            {copying && <span className="image-preview-copy-spinner" aria-hidden="true" />}
            {copyLabel('image', 'md.copyImage')}
          </button>
          {!diagramSvg && <button type="button" aria-label={t('md.copyImageAddress')} disabled={copying} onClick={() => void copy('address')}>
            {copyLabel('address', 'md.copyImageAddress')}
          </button>}
          <button type="button" disabled={downloading} onClick={() => void download()}>
            {downloading && <span className="image-preview-copy-spinner" aria-hidden="true" />}
            {t('md.downloadImage')}
          </button>
          {result?.src === resolved && result.action === 'download' && <span role="status">{t(result.key)}</span>}
        </div>
      </ResizablePanel>
    </div>,
    document.body,
  )
}
