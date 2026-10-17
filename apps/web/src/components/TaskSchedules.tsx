import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TaskScheduleSummary } from '../api/schedule'
import type { Project } from '../api/client'
import type { BoundScheduleTask } from './TaskScheduleEditor'
import type { ScheduleEditorState } from '../hooks/useScheduleDraftState'
import SchedulePage from '../pages/SchedulePage'
import ConfirmDialog from './ConfirmDialog'
import { useI18n } from '../i18n'
import { useOverlay } from '../hooks/useOverlay'
import { useCompactLayout } from '../hooks/useCompactLayout'
import Button from './Button'
import Icon from './Icon'
import ResizablePanel from './ResizablePanel'
import './TaskSchedules.css'

export type TaskSchedulesLoader = () => Promise<{ schedules: TaskScheduleSummary[] }>

/** Owns the task-scoped count and window; editing reuses the global schedule page. */
export default function TaskSchedules({ taskId, load, project, task }: {
  taskId: string; load: TaskSchedulesLoader; project?: Project; task?: BoundScheduleTask
}) {
  const { t } = useI18n()
  const [items, setItems] = useState<TaskScheduleSummary[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<ScheduleEditorState>({dirty:false,busy:false})
  const [confirmClose, setConfirmClose] = useState(false)
  const managed = Boolean(project && task)
  const managedOpen = useRef(false)
  managedOpen.current = managed && open
  const close = () => {
    if (editor.busy) return
    if (editor.dirty) setConfirmClose(true)
    else setOpen(false)
  }
  const onSchedulesChange = useCallback((schedules: TaskScheduleSummary[]) => setItems(schedules), [])
  const refresh = useRef<() => void>(() => {})
  const dialogRef = useRef<HTMLDivElement>(null)
  const compact = useCompactLayout()
  useOverlay(open, close, dialogRef, compact)

  useEffect(() => {
    let active = true, pending = false
    setItems([])
    setError('')
    setOpen(false)
    const update = async () => {
      if (pending) return
      pending = true
      setLoading(true)
      try {
        const result = await load()
        if (active) {
          setItems(result.schedules.filter(item => item.rule.kind !== 'once' || item.status !== 'completed'))
          setError('')
        }
      } catch (cause) {
        if (active) setError((cause as Error).message)
      } finally {
        pending = false
        if (active) setLoading(false)
      }
    }
    refresh.current = () => { void update() }
    const visibleUpdate = () => { if (!managedOpen.current && document.visibilityState !== 'hidden') void update() }
    void update()
    const timer = window.setInterval(visibleUpdate, 30_000)
    window.addEventListener('focus', visibleUpdate)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', visibleUpdate) }
  }, [taskId, load])

  return <>
    <button type="button" className="chat-input-attach task-schedules-trigger" aria-haspopup="dialog"
      aria-expanded={open} aria-label={`${t('schedules.title')}（${items.length}）`} title={t('schedules.title')}
      onClick={() => { setEditor({dirty:false,busy:false}); setOpen(true); if (!managed) refresh.current() }}>
      {loading ? <span className="task-status-spinner" aria-hidden="true"/> : <Icon name="clock" size={15}/>}
      {items.length > 0 && <span className="task-schedules-count">{items.length}</span>}
    </button>
    {open && createPortal(<div className="modal-overlay task-schedules-overlay" onClick={close}>
      <ResizablePanel ref={dialogRef} className={`modal task-schedules-dialog${managed ? ' task-schedules-dialog--manage' : ''}`} role="dialog" aria-modal="true"
        aria-label={t('schedules.title')} tabIndex={-1} minWidth={managed ? 720 : 360} minHeight={managed ? 420 : 300}
        onClick={event => event.stopPropagation()}>
        {project && task ? <SchedulePage project={project} boundTask={task} onClose={close}
          onSchedulesChange={onSchedulesChange} onEditorStateChange={setEditor}/> : <><header className="task-schedules-header" data-dialog-drag-handle>
          <strong>{t('schedules.title')}</strong>
          {loading && <span className="task-status-spinner" aria-hidden="true"/>}
          <Button variant="icon" aria-label={t('common.close')} onClick={() => setOpen(false)}><Icon name="x" size={16}/></Button>
        </header>
        <div className="task-schedules-body">
          {error && <div role="alert">{error}<Button onClick={() => refresh.current()}>{t('common.retry')}</Button></div>}
          {!loading && !error && items.length === 0 && <p>{t('schedules.taskEmpty')}</p>}
          {items.map(item => <article className="task-schedules-item" key={item.id}>
            <div className="task-schedules-item-heading"><strong>{item.name}</strong><span>{t(`schedules.status_${item.status}`)}</span></div>
            <div className="task-schedules-time">{item.rule.kind === 'once'
              ? new Date(item.rule.run_at).toLocaleString(undefined, {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})
              : item.summary}</div>
            {item.instruction && <p className="task-schedules-instruction">{item.instruction}</p>}
          </article>)}
        </div></>}
      </ResizablePanel>
    </div>, document.body)}
    {confirmClose && createPortal(<ConfirmDialog open title={t('schedules.unsavedTitle')}
      message={t('schedules.unsavedMessage')} confirmText={t('common.discard')}
      onCancel={() => setConfirmClose(false)} onConfirm={() => {setConfirmClose(false);setEditor({dirty:false,busy:false});setOpen(false)}}/>,document.body)}
  </>
}
