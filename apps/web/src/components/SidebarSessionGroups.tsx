import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { chatGroupApi, type ChatGroup, type GroupMutation } from '../api/chatGroups'
import type { ChatSessionSummary } from '../api/conversations'
import { useI18n } from '../i18n'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import { useChatWorkspaceStore } from '../stores/chatWorkspaceStore'
import { useRecentVisitsStore } from '../stores/recentVisitsStore'
import { appearanceStorage } from '../utils/appearanceStorage'
import { CHAT_SESSION_DRAG_TYPE, readChatSessionDrag } from '../utils/chatSessionDrag'
import ConfirmDialog from './ConfirmDialog'
import { SidebarActionMenu, SidebarActionItem } from './SidebarActionMenu'

import Icon from './Icon'
import Input from './Input'
import Spinner from './Spinner'
import SidebarStatusIndicator from './SidebarStatusIndicator'
import { useCompactLayout } from '../hooks/useCompactLayout'
import './SidebarSessionGroups.css'

const GROUP_DRAG_TYPE = 'application/x-workstep-chat-group'

type AnchorRect = { left: number; top: number; width: number; height: number }

/** Same compact icon rows as conversation menus, with viewport-safe placement. */
function GroupActionMenu({ anchor, group, onClose, onSelect, onNewSession, creatingSession = false }: {
  anchor: AnchorRect; group?: ChatGroup; onClose: () => void
  onSelect: (action: 'create' | 'archive' | 'delete') => void
  onNewSession?: () => void
  creatingSession?: boolean
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x: anchor.left, y: anchor.top })
  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect()
    setPosition({ x: Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(anchor.top, window.innerHeight - rect.height - 8)) })
    ref.current?.querySelector('button')?.focus()
  }, [anchor])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', onClose)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', onClose) }
  }, [onClose])
  return createPortal(<SidebarActionMenu ref={ref} x={position.x} y={position.y}>
    {!group && <SidebarActionItem icon="layers" onClick={() => onSelect('create')}>{t('sessionGroups.create')}</SidebarActionItem>}
    {group && <>
      {onNewSession && <SidebarActionItem icon="plus" disabled={creatingSession} onClick={onNewSession}>{t('chatSession.newSession')}</SidebarActionItem>}
      <SidebarActionItem icon="archive" onClick={() => onSelect('archive')}>{t('sessionGroups.archive')}</SidebarActionItem>
      <SidebarActionItem icon="trash" danger onClick={() => onSelect('delete')}>{t('sessionGroups.delete')}</SidebarActionItem>
    </>}
  </SidebarActionMenu>, document.body)
}

const GroupCreationContext = createContext({ requested: false, consume: () => {} })

/** Gives the conversation heading a context menu without adding state to Layout. */
export function SessionGroupCreationArea({ canManage, onOpen, children }: { canManage: boolean; onOpen: () => void; children: ReactNode }) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const [requested, setRequested] = useState(false)
  return <GroupCreationContext.Provider value={{ requested, consume: () => setRequested(false) }}>
    <div onContextMenu={event => {
      if (!canManage) return
      event.preventDefault(); event.stopPropagation()
      setAnchor({ left: event.clientX, top: event.clientY, width: 0, height: 0 })
    }}>{children}</div>
    {anchor && <GroupActionMenu anchor={anchor}
      onClose={() => setAnchor(null)} onSelect={() => { setAnchor(null); onOpen(); setRequested(true) }} />}
  </GroupCreationContext.Provider>
}

export default function SidebarSessionGroups({ projectId, source, sessions, canManage, renderSession, onCreateSession, creatingSession = false, runningSessions = {} }: {
  projectId: string; source: 'chat' | 'channel'; sessions: ChatSessionSummary[]; canManage: boolean
  onCreateSession?: (groupId: string) => Promise<string | undefined>
  creatingSession?: boolean
  runningSessions?: Record<string, boolean>
  renderSession: (session: ChatSessionSummary, onCreateGroup: () => void) => ReactNode
}) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const creation = useContext(GroupCreationContext)
  const [groups, setGroups] = useState<ChatGroup[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [creatingGroupId, setCreatingGroupId] = useState<string | null>(null)
  const createPending = useRef(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ anchor: AnchorRect; group?: ChatGroup } | null>(null)
  const [dialog, setDialog] = useState<{ action: 'create' | 'archive' | 'delete'; group?: ChatGroup } | null>(null)
  const [name, setName] = useState('')
  const [discard, setDiscard] = useState(false)
  const [deleteSessions, setDeleteSessions] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [groupDrop, setGroupDrop] = useState<{ id: string; before: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const clear = () => { setDropTarget(null); setGroupDrop(null) }
    const outside = (event: globalThis.DragEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) clear()
    }
    // Capture cleanup even when row/workspace drop handlers stop propagation.
    window.addEventListener('dragover', outside, true)
    window.addEventListener('drop', clear, true)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('dragover', outside, true)
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [])
  const storageKey = `workstep.session-groups.collapsed.${projectId}`
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try { return JSON.parse(appearanceStorage.getItem(storageKey) || '[]') } catch { return [] }
  })
  useEffect(() => {
    if (creation.requested) { setName(''); setDialog({ action: 'create' }); creation.consume() }
  }, [creation.requested])
  const load = async () => {
    setError('')
    try {
      const result = await chatGroupApi.list(projectId)
      if (!Array.isArray(result.groups)) throw new Error(t('sessionGroups.failed'))
      setGroups(result.groups); setLoaded(true)
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('sessionGroups.failed')) }
  }
  useEffect(() => { void load() }, [projectId])
  const mutate = async (mutation: GroupMutation) => {
    if (pending.current || !canManage || !loaded) return
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await chatGroupApi.mutate(projectId, mutation)
      setGroups(result.groups)
      setDialog(null)
      if (result.removed.length) {
        useRecentVisitsStore.getState().removeSessions(projectId, result.removed)
        for (const id of result.removed) {
          useChatListStore.getState().removeSession(id)
          if (mutation.action === 'delete') useChatSessionStore.getState().resetSession(id)
        }
        await useChatWorkspaceStore.getState().removeSessions(projectId, result.removed)
      }
      if (result.skipped.length) setError(t('sessionGroups.skipped', { count: result.skipped.length }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('sessionGroups.failed')) }
    finally { pending.current = false; setBusy(false) }
  }
  const drop = (event: DragEvent, groupId: string | null) => {
    const payload = readChatSessionDrag(event.dataTransfer)
    if (!canManage || busy || !payload || payload.projectId !== projectId || !sessions.some(s => s.id === payload.sessionId)) return
    event.preventDefault(); event.stopPropagation(); setDropTarget(null)
    void mutate({ action: 'move', group_id: groupId, session_id: payload.sessionId })
  }
  const dragOver = (event: DragEvent, id: string) => {
    if (!canManage || busy || !event.dataTransfer.types.includes(CHAT_SESSION_DRAG_TYPE)) return
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget(id)
  }
  const dropGroup = (event: DragEvent, targetId: string) => {
    if (!event.dataTransfer.types.includes(GROUP_DRAG_TYPE)) { drop(event, targetId); return }
    event.preventDefault(); event.stopPropagation(); setGroupDrop(null)
    if (!canManage || busy || compact) return
    try {
      const payload = JSON.parse(event.dataTransfer.getData(GROUP_DRAG_TYPE))
      if (payload.projectId !== projectId || payload.groupId === targetId || !groups.some(group => group.id === payload.groupId && group.source === source)) return
      const rect = event.currentTarget.getBoundingClientRect()
      void mutate({ action: 'reorder', group_id: payload.groupId, target_group_id: targetId, before: event.clientY < rect.top + rect.height / 2 })
    } catch { /* Unrelated or malformed drags do not change group order. */ }
  }
  const openMenu = (x: number, y: number, group?: ChatGroup) => {
    if (!canManage || busy || !loaded) return
    setMenu({ anchor: { left: x, top: y, width: 0, height: 0 }, group })
  }
  const createInGroup = async (groupId: string) => {
    if (!onCreateSession || createPending.current || creatingSession || busy) return
    createPending.current = true; setCreatingGroupId(groupId); setError('')
    try {
      const sessionId = await onCreateSession(groupId)
      if (!sessionId) return
      setGroups(current => current.map(group => group.id === groupId ? { ...group, session_ids: [...group.session_ids, sessionId] } : group))
      setCollapsed(current => {
        const next = current.filter(id => id !== groupId)
        appearanceStorage.setItem(storageKey, JSON.stringify(next))
        return next
      })
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('sessionGroups.failed')) }
    finally { createPending.current = false; setCreatingGroupId(null) }
  }
  const createGroup = () => { setName(''); setError(''); setDialog({ action: 'create' }) }
  const renderRow = (session: ChatSessionSummary) => renderSession(session, createGroup)
  const visibleGroups = groups.filter(group => group.source === source)
  const grouped = new Set(visibleGroups.flatMap(group => group.session_ids))
  const closeDialog = () => {
    if (busy) return
    if (dialog?.action === 'create' && name.trim()) setDiscard(true)
    else setDialog(null)
  }
  return <div ref={rootRef} className="sidebar-session-groups" onDragLeaveCapture={event => {
    if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null)
  }} onContextMenu={event => {
    if (!canManage) return
    event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY)
  }}>
    {(busy || creatingGroupId !== null || (!loaded && !error)) && <div className="sidebar-session-group-status" role="status"><Spinner size={13} /></div>}
    {error && <div className="sidebar-session-group-error" role="alert">{error}
      {!loaded && <button type="button" onClick={() => void load()}>{t('common.retry')}</button>}
    </div>}
    {visibleGroups.map(group => {
      const members = sessions.filter(session => group.session_ids.includes(session.id))
      return <div key={group.id} className="sidebar-session-group" data-session-group={group.id}
        onDropCapture={event => {
          const payload = readChatSessionDrag(event.dataTransfer)
          if (payload && !group.session_ids.includes(payload.sessionId)) drop(event, group.id)
        }}>
        <div className="sidebar-session-group-header" data-drop-target={dropTarget === group.id}
          draggable={!compact && canManage && !busy && !creatingSession && creatingGroupId === null}
          data-reorder-position={groupDrop?.id === group.id ? groupDrop.before ? 'before' : 'after' : undefined}
          onDragStart={event => {
            event.stopPropagation()
            if ((event.target as Element).closest('.sidebar-add-button, .sidebar-session-group-more')) { event.preventDefault(); return }
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(GROUP_DRAG_TYPE, JSON.stringify({ projectId, groupId: group.id }))
          }}
          onDragOver={event => {
            if (!event.dataTransfer.types.includes(GROUP_DRAG_TYPE)) { dragOver(event, group.id); return }
            if (compact || !canManage || busy) return
            event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'
            const rect = event.currentTarget.getBoundingClientRect()
            setGroupDrop({ id: group.id, before: event.clientY < rect.top + rect.height / 2 })
          }} onDragLeave={() => { setDropTarget(null); setGroupDrop(null) }} onDrop={event => dropGroup(event, group.id)}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY, group) }}>
          <button type="button" className="sidebar-session-group-toggle" aria-expanded={!collapsed.includes(group.id)} onClick={() => {
            const next = collapsed.includes(group.id) ? collapsed.filter(id => id !== group.id) : [...collapsed, group.id]
            setCollapsed(next); appearanceStorage.setItem(storageKey, JSON.stringify(next))
          }}><Icon name={collapsed.includes(group.id) ? 'chevron-right' : 'chevron-down'} size={12} />
            <Icon name="layers" size={13} /><span className="sidebar-session-group-name" title={group.name}>{group.name}</span>
            <span className="sidebar-session-group-count">{members.length}</span>
          </button>
          <SidebarStatusIndicator running={group.session_ids.some(id => runningSessions[id])}
            runningTitle={t('chatSession.runningHint')} failedTitle={t('layout.failedState')} completedTitle={t('layout.completedUnread')} />

          {canManage && <button type="button" className="sidebar-session-group-more" aria-label={t('sessionGroups.actions')} disabled={busy}
            onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom, group) }}><Icon name="ellipsis" size={14} /></button>}

        </div>
        {!collapsed.includes(group.id) && <div className="sidebar-session-group-members">{members.map(renderRow)}</div>}
      </div>
    })}
    <div className="sidebar-session-group-ungrouped" data-drop-target={dropTarget === 'ungrouped'}
      onDragOver={event => { if (event.target === event.currentTarget) dragOver(event, 'ungrouped') }} onDragLeave={() => setDropTarget(null)}
      onDropCapture={event => {
        const payload = readChatSessionDrag(event.dataTransfer)
        if (payload && grouped.has(payload.sessionId)) drop(event, null)
      }}>
      {sessions.filter(session => !grouped.has(session.id)).map(renderRow)}
    </div>
    {!sessions.length && !visibleGroups.length && canManage && <button type="button" className="sidebar-session-group-create" disabled={!loaded || busy}
      onClick={() => { setName(''); setDialog({ action: 'create' }) }}>{t('sessionGroups.create')}</button>}
    {menu && <GroupActionMenu anchor={menu.anchor} group={menu.group} onClose={() => setMenu(null)}
      creatingSession={creatingSession || creatingGroupId !== null}
      onNewSession={menu.group && source === 'chat' && onCreateSession ? () => {
        const groupId = menu.group!.id
        setMenu(null)
        void createInGroup(groupId)
      } : undefined}
      onSelect={action => { setName(''); setError(''); setDeleteSessions(false); setDialog({ action, group: menu.group }); setMenu(null) }} />}
    {dialog && <ConfirmDialog open title={t(`sessionGroups.${dialog.action}`)} danger={dialog.action === 'delete' && deleteSessions} loading={busy}
      confirmDisabled={!loaded || (dialog.action === 'create' && !name.trim())}
      message={dialog.group && dialog.action !== 'create' ? t(dialog.action === 'delete' && deleteSessions ? 'sessionGroups.deleteWithSessionsConfirm' : `sessionGroups.${dialog.action}Confirm`, { name: dialog.group.name, count: dialog.group.session_ids.length }) : undefined}
      onCancel={closeDialog} onConfirm={() => void mutate(dialog.action === 'create'
        ? { action: 'create', name: name.trim(), source }
        : { action: dialog.action === 'delete' && !deleteSessions ? 'dissolve' : dialog.action, group_id: dialog.group!.id, ...(dialog.action === 'delete' ? { delete_sessions: deleteSessions } : {}) })}>
      {dialog.action === 'delete' && <label className="sidebar-session-group-delete-option">
        <input type="checkbox" checked={deleteSessions} disabled={busy} onChange={event => setDeleteSessions(event.target.checked)} />
        <span>{t('sessionGroups.deleteSessions')}</span>
      </label>}
      {dialog.action === 'create' && <Input autoFocus aria-label={t('sessionGroups.name')} maxLength={80} value={name} placeholder={t('sessionGroups.name')}
        onChange={event => setName(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && name.trim()) void mutate({ action: 'create', name: name.trim(), source })
        }} />}
      {error && <div className="sidebar-session-group-error" role="alert">{error}</div>}
    </ConfirmDialog>}
    <ConfirmDialog open={discard} title={t('sessionGroups.discard')} onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); setDialog(null) }} />
  </div>
}
