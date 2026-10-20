import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import MobileSheet from './MobileSheet'
import Button from './Button'
import Icon from './Icon'

export default function MobileTaskRow({ title, status, archived, canArchive, canDelete, onOpen, onArchive, onRestore, onDelete, children }: {
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
  const hasActions = allowArchive || allowDelete
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
    if (!hasActions || event.button !== 0 || event.pointerType === 'mouse') return
    pending.current = {
      x: event.clientX, y: event.clientY,
      timer: setTimeout(() => {
        pending.current = null
        suppressClick.current = true
        setMenuOpen(true)
      }, 500),
    }
  }
  const action = (callback: () => void) => {
    setMenuOpen(false)
    callback()
  }
  return <>
    <button type="button" className="mobile-task-row" aria-haspopup={hasActions ? 'dialog' : undefined}
      onPointerDown={start}
      onPointerMove={event => {
        if (pending.current && Math.hypot(event.clientX - pending.current.x, event.clientY - pending.current.y) > 10) cancel()
      }}
      onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
      onContextMenu={event => {
        event.preventDefault()
        cancel()
        if (hasActions) { suppressClick.current = true; setMenuOpen(true) }
      }}
      onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return }
        onOpen()
      }}>
      {children}
    </button>
    <MobileSheet open={menuOpen && hasActions} title={title} onClose={() => setMenuOpen(false)}>
      <div className="mobile-task-menu">
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
