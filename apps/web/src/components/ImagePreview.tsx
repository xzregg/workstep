import ResizablePanel from './ResizablePanel'
import { useEffect, useState } from 'react'
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

export default function ImagePreview({ src, alt, projectId, onClose }: ImagePreviewProps) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const markdownUrlResolver = useMarkdownUrlResolver()
  const resolved = markdownUrlResolver?.(src) ?? resolveMarkdownImageSrc(src, projectId)
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
        'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif' }[blob.type]
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
      className="image-preview"
      role="dialog"
      aria-modal="true"
      aria-label={`${t('md.preview')}：${alt || t('md.image')}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <ResizablePanel className="image-preview-window" minWidth={280} minHeight={160}>
        {!compact && <div className="preview-drag-handle" data-dialog-drag-handle role="button" tabIndex={0} aria-label={t('taskDetail.dragWindowAria')} title={t('taskDetail.dragWindowTitle')} />}
        {!compact && <div className="image-preview-header">{closeButton}</div>}
        {compact && closeButton}
        <img src={resolved} alt={alt || t('md.image')} />
        <div className="image-preview-toolbar">
          <button type="button" aria-label={t('md.copyImage')} disabled={copying} onClick={() => void copy('image')}>
            {copying && <span className="image-preview-copy-spinner" aria-hidden="true" />}
            {copyLabel('image', 'md.copyImage')}
          </button>
          <button type="button" aria-label={t('md.copyImageAddress')} disabled={copying} onClick={() => void copy('address')}>
            {copyLabel('address', 'md.copyImageAddress')}
          </button>
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
