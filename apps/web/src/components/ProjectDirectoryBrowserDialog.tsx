import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import { useI18n } from '../i18n'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'
import ProjectDirectoryBrowser from './ProjectDirectoryBrowser'
import type { DirectoryBrowseResult } from '../api/client'

interface ProjectDirectoryBrowserDialogProps {
  projectId: string
  title: string
  rootPath?: string
  displayPath?: string
  browseDirectory?: (path: string, includeHidden: boolean) => Promise<DirectoryBrowseResult>
  readOnly?: boolean
  initialFilePath?: string
  onSelectFile?: (path: string) => void
  headerActions?: ReactNode
  onClose: () => void
}

type ResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type DialogBounds = { x: number; y: number; width: number; height: number }
const RESIZE_EDGES: ResizeEdge[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']
const RESIZE_LABELS = {
  n: 'taskDetail.resize.n', e: 'taskDetail.resize.e',
  s: 'taskDetail.resize.s', w: 'taskDetail.resize.w',
  ne: 'taskDetail.resize.ne', nw: 'taskDetail.resize.nw',
  se: 'taskDetail.resize.se', sw: 'taskDetail.resize.sw',
} as const

function minimumSize() {
  return { width: Math.min(520, window.innerWidth - 16), height: Math.min(320, window.innerHeight - 16) }
}

function resizeBounds(start: DialogBounds, edge: ResizeEdge, dx: number, dy: number): DialogBounds {
  const minimum = minimumSize()
  let { x, y, width, height } = start
  if (edge.includes('w')) {
    const right = start.x + start.width
    x = Math.min(Math.max(0, start.x + dx), right - minimum.width)
    width = right - x
  }
  if (edge.includes('e')) width = Math.min(Math.max(minimum.width, start.width + dx), window.innerWidth - start.x)
  if (edge.includes('n')) {
    const bottom = start.y + start.height
    y = Math.min(Math.max(0, start.y + dy), bottom - minimum.height)
    height = bottom - y
  }
  if (edge.includes('s')) height = Math.min(Math.max(minimum.height, start.height + dy), window.innerHeight - start.y)
  return { x, y, width, height }
}

function clampBounds(bounds: DialogBounds): DialogBounds {
  const width = Math.min(bounds.width, window.innerWidth)
  const height = Math.min(bounds.height, window.innerHeight)
  return {
    x: Math.min(Math.max(0, bounds.x), window.innerWidth - width),
    y: Math.min(Math.max(0, bounds.y), window.innerHeight - height),
    width, height,
  }
}

export default function ProjectDirectoryBrowserDialog({
  projectId,
  title,
  rootPath,
  displayPath,
  browseDirectory,
  readOnly = false,
  initialFilePath,
  onSelectFile,
  headerActions,
  onClose,
}: ProjectDirectoryBrowserDialogProps) {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLElement>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const [bounds, setBounds] = useState<DialogBounds | null>(null)
  const [dirty, setDirty] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const compact = useCompactLayout()
  const requestClose = () => { if (dirty) setConfirmClose(true); else onClose() }
  useOverlay(true, requestClose, dialogRef, compact)

  useEffect(() => {
    const onViewportResize = () => setBounds((current) => current ? clampBounds(current) : null)
    window.addEventListener('resize', onViewportResize)
    return () => {
      window.removeEventListener('resize', onViewportResize)
      resizeCleanupRef.current?.()
    }
  }, [])

  const currentBounds = (): DialogBounds => {
    const rect = dialogRef.current?.getBoundingClientRect()
    if (rect?.width && rect?.height) {
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    }
    return bounds || {
      x: window.innerWidth * 0.05, y: window.innerHeight * 0.05,
      width: window.innerWidth * 0.9, height: window.innerHeight * 0.9,
    }
  }

  const beginResize = (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const start = currentBounds()
    const pointer = { x: event.clientX, y: event.clientY }
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = getComputedStyle(event.currentTarget).cursor
    document.body.style.userSelect = 'none'
    const move = (next: PointerEvent) => setBounds(resizeBounds(start, edge, next.clientX - pointer.x, next.clientY - pointer.y))
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      resizeCleanupRef.current = null
    }
    resizeCleanupRef.current?.()
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const resizeWithKeyboard = (edge: ResizeEdge, event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 12
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    if (!dx && !dy) return
    event.preventDefault()
    setBounds(resizeBounds(currentBounds(), edge, dx, dy))
  }

  const beginMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (compact || event.button !== 0 || (event.target as HTMLElement).closest('button, input, textarea, select, a')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const start = currentBounds()
    const pointer = { x: event.clientX, y: event.clientY }
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'move'
    document.body.style.userSelect = 'none'
    const move = (next: PointerEvent) => setBounds(clampBounds({
      ...start,
      x: start.x + next.clientX - pointer.x,
      y: start.y + next.clientY - pointer.y,
    }))
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      resizeCleanupRef.current = null
    }
    resizeCleanupRef.current?.()
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const moveWithKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return
    const step = event.shiftKey ? 40 : 12
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    if (!dx && !dy) return
    event.preventDefault()
    const start = currentBounds()
    setBounds(clampBounds({ ...start, x: start.x + dx, y: start.y + dy }))
  }

  return createPortal(<>
    <div
      className="project-directory-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <section
        ref={dialogRef}
        className="project-directory-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-directory-dialog-title"
        style={!compact && bounds ? ({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height } satisfies CSSProperties) : undefined}
      >
        {!compact && RESIZE_EDGES.map((edge) => (
          <div
            key={edge}
            className={`project-directory-dialog-resize-handle project-directory-dialog-resize-${edge}`}
            role="separator"
            tabIndex={0}
            aria-label={t(RESIZE_LABELS[edge])}
            onPointerDown={(event) => beginResize(edge, event)}
            onKeyDown={(event) => resizeWithKeyboard(edge, event)}
          />
        ))}
        <header
          className="project-directory-dialog-header"
          tabIndex={compact ? undefined : 0}
          aria-label={compact ? undefined : t('taskDetail.dragWindowAria')}
          onPointerDown={beginMove}
          onKeyDown={moveWithKeyboard}
        >
          <span className="project-directory-dialog-icon" aria-hidden="true">
            <Icon name="folder" size={16} strokeWidth={1.8} />
          </span>
          <div className="project-directory-dialog-heading">
            <strong id="project-directory-dialog-title">{title}</strong>
            <span title={displayPath}>{displayPath || t('browser.projectRoot')}</span>
          </div>
          {headerActions}
          <Button
            variant="icon"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={requestClose}
            style={{ width: 30, height: 30, minWidth: 30, padding: 0 }}
          >
            <Icon name="x" size={15} strokeWidth={2} />
          </Button>
        </header>
        <div className="project-directory-dialog-body">
          <ProjectDirectoryBrowser
            projectId={projectId} rootPath={rootPath} initialFilePath={initialFilePath}
            browseDirectory={browseDirectory} readOnly={readOnly}
            onSelectedFileChange={setSelectedFile} onDirtyChange={setDirty}
          />
        </div>
        {onSelectFile && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '8px 16px', borderTop: '1px solid var(--border)' }}>
          <Button variant="ghost" onClick={requestClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!selectedFile || dirty} onClick={() => { if (selectedFile) onSelectFile(selectedFile) }}>选择此脚本</Button>
        </div>}
      </section>
    </div>
    <ConfirmDialog
      open={confirmClose}
      title={t('browser.unsavedTitle')}
      message={t('browser.unsavedMessage')}
      confirmText={t('browser.discardChanges')}
      danger
      zIndex={2400}
      onCancel={() => setConfirmClose(false)}
      onConfirm={onClose}
    />
  </>,
    document.body,
  )
}
