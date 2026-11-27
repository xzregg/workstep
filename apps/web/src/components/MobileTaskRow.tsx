import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import MobileSheet from './MobileSheet'
import Button from './Button'
import Icon from './Icon'
import TaskCopyButton from './TaskCopyButton'
import './MobileTaskRow.css'

export default function MobileTaskRow({ title, status, archived, canArchive, canDelete, onOpen, onArchive, onRestore, onDelete, projectId, taskId, canStart = false, starting = false, readOnly = false, onStart, selectionMode = false, selected = false, selectionDisabled = false, onSelect, children }: {
  selectionMode?: boolean
  selected?: boolean
  selectionDisabled?: boolean
  onSelect?: () => void
  projectId?: string
  taskId?: string
  canStart?: boolean
  starting?: boolean
  readOnly?: boolean
  onStart?: () => void
  title: string
  status: string
  archived: boolean
  canArchive: boolean
  canDelete: boolean
  onOpen: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
  children: ReactNode
}) {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const allowArchive = canArchive && (archived || status !== 'running')
  const allowDelete = canDelete && status !== 'running'
  const allowStart = canStart && !archived && !['running', 'queued'].includes(status) && Boolean(onStart)
  const cancel = () => {
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = null
  }
  useEffect(() => {
    window.addEventListener('scroll', cancel, true)
    return () => { cancel(); window.removeEventListener('scroll', cancel, true) }
  }, [])
  const start = (event: PointerEvent<HTMLButtonElement>) => {
    cancel()
    suppressClick.current = false
    if (selectionMode || selectionDisabled) return
    if (event.button !== 0 || event.pointerType === 'mouse') return
    pending.current = {
      x: event.clientX, y: event.clientY,
      timer: setTimeout(() => {
        pending.current = null
        suppressClick.current = true
        if (onSelect) onSelect()
        else setMenuOpen(true)
      }, 500),
    }
  }
  const action = (callback: () => void) => {
    setMenuOpen(false)
    callback()
  }
  return <>
    <div className="mobile-task-row-container">
    <button type="button" className="mobile-task-row" aria-haspopup={onSelect ? undefined : 'dialog'}
      aria-pressed={selectionMode ? selected : undefined}
      aria-disabled={selectionMode && selectionDisabled || undefined}
      data-selecting={selectionMode || undefined}
      data-selected={selected || undefined} data-board-task-id={taskId}
      onPointerDown={start}
      onPointerMove={event => {
        if (pending.current && Math.hypot(event.clientX - pending.current.x, event.clientY - pending.current.y) > 10) cancel()
      }}
      onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
      onContextMenu={event => {
        event.preventDefault()
        const heldTouch = Boolean(pending.current)
        cancel()
        if (onSelect && heldTouch && !selectionMode && !selectionDisabled) {
          suppressClick.current = true
          onSelect()
        }
        if (!onSelect) { suppressClick.current = true; setMenuOpen(true) }
      }}
      onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return }
        if (selectionMode) { if (!selectionDisabled) onSelect?.(); return }
        onOpen()
      }}>
      {selectionMode && <span className="mobile-task-selection-mark" aria-hidden="true">
        {selected && <Icon name="check" size={12} />}
      </span>}
      {children}
    </button>
    {onSelect && !selectionMode && <Button
      variant="ghost" className="mobile-task-row-more"
      aria-label={t('layout.moreActions')} title={t('layout.moreActions')}
      aria-haspopup="dialog" aria-expanded={menuOpen}
      onPointerDown={event => { event.stopPropagation(); cancel() }}
      onContextMenu={event => event.preventDefault()}
      onClick={event => { event.stopPropagation(); cancel(); setMenuOpen(true) }}>
      <Icon name="ellipsis" />
    </Button>}
    </div>
    <MobileSheet open={menuOpen} title={title} onClose={() => setMenuOpen(false)}>
      <div className="mobile-task-menu">
        {allowStart && <Button data-task-action="start" disabled={starting} loading={starting} onClick={() => action(onStart!)}>
          <Icon name="play" size={16} />{t('taskList.startTask')}
        </Button>}
        <Button onClick={() => action(onOpen)}>
          <Icon name={readOnly ? 'eye' : 'pencil'} size={16} />{t(readOnly ? 'common.view' : 'common.edit')}
        </Button>
        {projectId && taskId && <TaskCopyButton taskId={taskId} projectId={projectId} title={title} presentation="menu" onCopied={() => setMenuOpen(false)} />}
        {allowArchive && <Button onClick={() => action(archived ? onRestore : onArchive)}>
          <Icon name={archived ? 'rotate-ccw' : 'archive'} size={16} />{t(archived ? 'taskList.restoreToBoard' : 'taskList.archiveTask')}
        </Button>}
        {allowDelete && <Button className="mobile-task-delete" onClick={() => action(onDelete)}>
          <Icon name="trash" size={16} />{t('common.delete')}
        </Button>}
      </div>
    </MobileSheet>
  </>
}
