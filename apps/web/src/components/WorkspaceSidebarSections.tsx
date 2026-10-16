import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useI18n } from '../i18n'
import { appearanceStorage, appearanceStorageKey } from '../utils/appearanceStorage'
import Icon from './Icon'
import RecentConversations from './RecentConversations'

type Section = 'projects' | 'recent'
interface Preferences { order: Section[]; collapsed: Record<Section, boolean>; recentShare: number }
interface DragPreview { section: Section; x: number; y: number; target: Section | null }
const KEY = 'workstep.sidebar-panels.v1'
const clampShare = (value: number) => Math.min(0.85, Math.max(0.15, value))
const initial = (): Preferences => ({ order: ['projects', 'recent'], collapsed: { projects: false, recent: false }, recentShare: 1 / 3 })
function read(): Preferences {
  try {
    const saved = JSON.parse(appearanceStorage.getItem(KEY) || 'null')
    return {
      order: saved?.order?.length === 2 && saved.order.includes('projects') && saved.order.includes('recent') ? saved.order : initial().order,
      collapsed: { projects: saved?.collapsed?.projects === true, recent: saved?.collapsed?.recent === true },
      recentShare: typeof saved?.recentShare === 'number' && Number.isFinite(saved.recentShare) ? clampShare(saved.recentShare) : 1 / 3,
    }
  } catch { return initial() }
}

/** Desktop panel preferences are separate from the original project/flow/session tree. */
export default function WorkspaceSidebarSections({ projectActions, projects, now, onProjectVisibilityChange }: {
  projectActions: ReactNode
  projects: ReactNode
  now?: number
  onProjectVisibilityChange?: (visible: boolean) => void
}) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const scope = appearanceStorageKey(KEY)
  const [preferences, setPreferences] = useState(read)
  const [dragging, setDragging] = useState<DragPreview | null>(null)
  const [resizing, setResizing] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const previousPositions = useRef(new Map<Element, number>())
  const stopDrag = useRef<(() => void) | null>(null)
  const suppressClick = useRef(false)
  useEffect(() => { setPreferences(read()); setDragging(null) }, [scope])
  useEffect(() => () => stopDrag.current?.(), [compact, scope])
  const collapsed = (section: Section) => !compact && preferences.collapsed[section]
  const projectVisible = !collapsed('projects')
  useEffect(() => { onProjectVisibilityChange?.(projectVisible) }, [projectVisible, onProjectVisibilityChange])
  const save = (next: Preferences) => {
    setPreferences(next)
    appearanceStorage.setItem(KEY, JSON.stringify(next))
  }
  useLayoutEffect(() => {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const [element, top] of previousPositions.current) {
        const offset = top - element.getBoundingClientRect().top
        if (offset) element.animate?.([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' })
      }
    }
    previousPositions.current.clear()
  }, [preferences.order])
  const swap = () => {
    previousPositions.current = new Map([...body.current?.children ?? []].map(element => [element, element.getBoundingClientRect().top]))
    save({ ...preferences, order: [...preferences.order].reverse() })
  }
  const sectionAt = (pointer: PointerEvent): Section | null => {
    const element = document.elementFromPoint?.(pointer.clientX, pointer.clientY) ?? pointer.target as Element
    if (!body.current?.contains(element)) return null
    if (element.closest('.layout-sidebar-project-panel')) return 'projects'
    if (element.closest('.layout-sidebar-recent')) return 'recent'
    return null
  }
  const heading = (section: Section) => {
    const title = t(section === 'projects' ? 'layout.projects' : 'layout.recentConversations')
    const start = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (compact || (event.target as HTMLElement).closest('input, .layout-sidebar-search-button')) return
      if (event.button !== 0) return
      stopDrag.current?.()
      const startX = event.clientX, startY = event.clientY
      let moved = false
      const move = (pointer: PointerEvent) => {
        if (!moved && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) > 6) moved = true
        if (moved) {
          pointer.preventDefault()
          const target = sectionAt(pointer)
          setDragging({ section, x: pointer.clientX, y: pointer.clientY, target: target === section ? null : target })
        }
      }
      const stop = () => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', drop)
        document.removeEventListener('pointercancel', stop)
        document.removeEventListener('keydown', cancel)
        window.removeEventListener('blur', stop)
        stopDrag.current = null; setDragging(null)
      }
      const cancel = (key: KeyboardEvent) => { if (key.key === 'Escape') { suppressClick.current = true; stop() } }
      const drop = (pointer: PointerEvent) => {
        const target = sectionAt(pointer)
        if (moved) {
          suppressClick.current = true
          if (target && target !== section) swap()
        }
        stop()
      }
      stopDrag.current = stop
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', drop)
      document.addEventListener('pointercancel', stop)
      document.addEventListener('keydown', cancel)
      window.addEventListener('blur', stop)
    }
    return <div className="layout-sidebar-section-label" data-sidebar-section-heading={section}
      data-reorderable={!compact || undefined} data-dragging={dragging?.section === section || undefined}
      data-drop-position={dragging?.target === section ? preferences.order.indexOf(dragging.section) > preferences.order.indexOf(section) ? 'before' : 'after' : undefined}
      onPointerDown={start} onDragStart={event => event.preventDefault()}>
      {compact ? <span>{title}</span> : <button type="button" className="layout-sidebar-section-toggle"
        aria-expanded={!collapsed(section)} aria-controls={`workspace-${section}-content`}
        title={t('layout.sidebarSectionDragHint')}
        onClick={() => save({ ...preferences, collapsed: { ...preferences.collapsed, [section]: !preferences.collapsed[section] } })}
        onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); swap() } }}>
        <span>{title}</span><Icon name={collapsed(section) ? 'chevron-right' : 'chevron-down'} size={12} />
      </button>}
      {section === 'projects' && projectActions}
    </div>
  }
  const order = compact ? initial().order : preferences.order
  const resizable = !compact && !order.some(section => collapsed(section))
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !resizable || !body.current) return
    event.preventDefault(); event.stopPropagation(); stopDrag.current?.()
    const height = body.current.getBoundingClientRect().height - event.currentTarget.getBoundingClientRect().height
    if (height <= 0) return
    const startY = event.clientY
    let latest = preferences
    setResizing(true)
    const move = (pointer: PointerEvent) => {
      pointer.preventDefault()
      const delta = (pointer.clientY - startY) / height * (order[0] === 'recent' ? 1 : -1)
      latest = { ...preferences, recentShare: clampShare(preferences.recentShare + delta) }
      setPreferences(latest)
    }
    const stop = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', cancel); document.removeEventListener('keydown', key)
      window.removeEventListener('blur', finish)
      stopDrag.current = null; setResizing(false)
    }
    const finish = () => { save(latest); stop() }
    const cancel = () => { setPreferences(preferences); stop() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    stopDrag.current = stop
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', cancel); document.addEventListener('keydown', key)
    window.addEventListener('blur', finish)
  }
  const rows = order.map(section => collapsed(section) ? '32px' : `minmax(0, ${resizable ? section === 'recent' ? preferences.recentShare : 1 - preferences.recentShare : 1}fr)`).join(resizable ? ' 6px ' : ' ')
  const panels = order.map(section => section === 'projects'
      ? <section key={section} id="layout-project-panel" tabIndex={-1} className="layout-sidebar-project-panel" aria-label={t('layout.projects')}>
        {heading(section)}
        <div id="workspace-projects-content" className="layout-sidebar-section-content" hidden={collapsed(section)}>{projects}</div>
      </section>
      : <RecentConversations key={section} now={now} heading={heading(section)} collapsed={collapsed(section)} />)
  return <><div ref={body} className="layout-sidebar-body" data-section-dragging={!!dragging || undefined} data-section-resizing={resizing || undefined} style={compact ? undefined : { gridTemplateRows: rows }}
    onPointerDownCapture={() => { suppressClick.current = false }}
    onClickCapture={event => { if (suppressClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false } }}>
    {panels[0]}
    {resizable && <div className="layout-sidebar-section-resizer" role="separator" tabIndex={0}
      aria-label={t('layout.sidebarSectionResize')} title={t('layout.sidebarSectionResize')}
      aria-orientation="horizontal" aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(preferences.recentShare * 100)}
      aria-controls="workspace-recent-content" onPointerDown={resize}
      onDoubleClick={() => save({ ...preferences, recentShare: 1 / 3 })}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
        event.preventDefault()
        const delta = (event.key === 'ArrowDown' ? 0.05 : -0.05) * (order[0] === 'recent' ? 1 : -1)
        save({ ...preferences, recentShare: event.key === 'Home' ? 1 / 3 : clampShare(preferences.recentShare + delta) })
      }} />}
    {panels[1]}
  </div>
    {dragging && createPortal(<div className="layout-sidebar-drag-preview" aria-hidden="true"
      style={{ left: dragging.x, top: dragging.y }}>
      <Icon name="grip-vertical" size={14} />
      {t(dragging.section === 'projects' ? 'layout.projects' : 'layout.recentConversations')}
    </div>, document.body)}
  </>
}
