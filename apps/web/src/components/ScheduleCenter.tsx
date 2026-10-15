import { useContext, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectStore } from '../stores/projectStore'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { resolveProjectPermissions } from '../utils/projectPermissions'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { useOverlay } from '../hooks/useOverlay'
import { useCompactLayout } from '../hooks/useCompactLayout'
import type { ScheduleEditorState } from '../hooks/useScheduleDraftState'
import { useI18n } from '../i18n'
import SchedulePage from '../pages/SchedulePage'
import Button from './Button'
import Icon from './Icon'
import ConfirmDialog from './ConfirmDialog'
import ResizablePanel from './ResizablePanel'
import { NavigationDismissContext } from './NavigationDismissContext'
import './ScheduleCenter.css'

/** The global entry owns only its window and project tabs; SchedulePage owns scheduling. */
export default function ScheduleCenter() {
  const { t } = useI18n()
  const dismissNavigation = useContext(NavigationDismissContext)
  const projects = useProjectStore(state => state.projects)
  const activeProjectId = useProjectStore(state => state.activeProject?.id)
  const session = useGatewaySessionStore(state => state.session)
  const remote = isGatewayRemoteBrowser()
  const available = projects.filter(project => resolveProjectPermissions(remote, session, project.id).can('schedule.read'))
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [editor, setEditor] = useState<ScheduleEditorState>({ dirty: false, busy: false })
  const [pending, setPending] = useState<{ projectId: string } | { close: true } | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null)
  const compact = useCompactLayout()
  const project = available.find(item => item.id === projectId) ?? available[0]
  const apply = (action: NonNullable<typeof pending>) => {
    setEditor({ dirty: false, busy: false })
    setPending(null)
    if ('close' in action) setOpen(false)
    else setProjectId(action.projectId)
  }
  const request = (action: NonNullable<typeof pending>) => {
    if (editor.busy) return
    if (editor.dirty) setPending(action)
    else apply(action)
  }
  const close = () => request({ close: true })
  useOverlay(open, close, dialogRef, compact)

  // A project-bound Gateway session must never offer tabs from another scope.
  if (resolveProjectPermissions(remote, session, project?.id).bound && !project) return null

  const tabs = <div className="schedule-center-tabs" role="tablist" aria-label={t('schedules.projects')}>
    {available.map(item => <button type="button" key={item.id} role="tab"
      id={`schedule-project-${item.id}`} aria-selected={item.id === project?.id}
      aria-controls={`schedule-content-${item.id}`} tabIndex={item.id === project?.id ? 0 : -1}
      disabled={editor.busy} title={item.name}
      onClick={() => { if (item.id !== project?.id) request({ projectId: item.id }) }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || editor.busy) return
        event.preventDefault()
        const index = available.findIndex(entry => entry.id === item.id)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length
        const target = available[next]
        if (target.id !== project?.id) request({ projectId: target.id })
        document.getElementById(`schedule-project-${target.id}`)?.focus()
      }}>{item.name}</button>)}
  </div>

  return <>
    <Button variant="ghost" className="layout-sidebar-nav-button" aria-haspopup="dialog" aria-label={t('schedules.title')}
      aria-expanded={open} aria-current={open ? 'page' : undefined}
      onClick={() => { setProjectId(available.find(item => item.id === activeProjectId)?.id ?? available[0]?.id ?? null); setOpen(true); dismissNavigation() }}>
      <Icon name="clock" size={17} strokeWidth={2} /><span className="layout-sidebar-action-label">{t('schedules.title')}</span>
    </Button>
    {open && createPortal(<div className="modal-overlay schedule-dialog-overlay schedule-center-overlay" onClick={close}>
      <ResizablePanel ref={dialogRef} className="modal schedule-dialog schedule-center-dialog"
        role="dialog" aria-modal="true" aria-label={t('schedules.title')} tabIndex={-1}
        minWidth={720} minHeight={420} onClick={event => event.stopPropagation()}>
        {project ? <>
          <div className="schedule-center-header" ref={setHeaderTarget} />
          {tabs}
          {headerTarget && <SchedulePage key={project.id} project={project} onClose={close}
            headerTarget={headerTarget} tabbed onEditorStateChange={setEditor} />}
        </> : <>
          <header className="schedule-center-empty-header" data-dialog-drag-handle>
            <strong>{t('schedules.title')}</strong>
            <Button variant="icon" aria-label={t('common.close')} onClick={close}><Icon name="x" size={16} /></Button>
          </header>
          <div className="schedule-center-empty">{t('nav.noProjects')}</div>
        </>}
      </ResizablePanel>
    </div>, document.body)}
    <ConfirmDialog open={pending !== null} title={t('schedules.unsavedTitle')}
      message={t('schedules.unsavedMessage')} confirmText={t('common.discard')}
      onCancel={() => setPending(null)} onConfirm={() => { if (pending) apply(pending) }} />
  </>
}
