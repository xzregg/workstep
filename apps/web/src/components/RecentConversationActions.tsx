import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatSessionSummary } from '../api/client'
import { useI18n } from '../i18n'
import { useSidebarSessionActions } from '../hooks/useSidebarSessionActions'
import { useOverlay } from '../hooks/useOverlay'
import type { RecentVisit } from '../stores/recentVisitsStore'
import SessionRowActions from './SessionRowActions'
import { SidebarActionItem, SidebarActionMenu } from './SidebarActionMenu'
import ChatSessionRenameDialog from './ChatSessionRenameDialog'
import ConfirmDialog from './ConfirmDialog'
import Spinner from './Spinner'
import Button from './Button'
import Icon from './Icon'

/** The recent list uses the same conversation controls and mutation paths as the project list. */
export default function RecentConversationActions({ entry, session, hovered, now }: {
  entry: RecentVisit
  session: Pick<ChatSessionSummary, 'id' | 'title' | 'created_at' | 'updated_at'>
  hovered: boolean
  now: number
}) {
  const { t } = useI18n()
  const { archiveSession, deleteSession, sessionError, clearSessionError } = useSidebarSessionActions()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [mode, setMode] = useState<'rename' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useOverlay(Boolean(menu), () => setMenu(null), menuRef, false)
  useEffect(() => {
    if (!menu) return
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])

  const archive = async () => {
    if (busy) return
    setMenu(null)
    setBusy(true)
    try { await archiveSession(entry.id, entry.projectId) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (busy) return
    setBusy(true)
    try { if (await deleteSession(entry.id, entry.projectId)) setMode(null) } finally { setBusy(false) }
  }
  return <>
    {busy ? <Spinner size={13} /> : <SessionRowActions session={session} hovered={hovered} now={now} showMore
      onArchive={() => { void archive() }}
      onMore={event => {
        event.stopPropagation()
        clearSessionError()
        const rect = event.currentTarget.getBoundingClientRect()
        setMenu({ x: Math.max(8, Math.min(rect.right - 148, window.innerWidth - 156)), y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 144)) })
      }} />}
    {createPortal(<>
      {menu && <SidebarActionMenu ref={menuRef} x={menu.x} y={menu.y}>
        <SidebarActionItem icon="archive" onClick={() => { void archive() }}>{t('chatSession.archive')}</SidebarActionItem>
        <SidebarActionItem icon="pencil" onClick={() => { setMenu(null); setMode('rename') }}>{t('common.rename')}</SidebarActionItem>
        <SidebarActionItem icon="trash" danger onClick={() => { setMenu(null); setMode('delete') }}>{t('common.delete')}</SidebarActionItem>
      </SidebarActionMenu>}
      {mode === 'rename' && <ChatSessionRenameDialog projectId={entry.projectId} sessionId={entry.id} title={session.title}
        onClose={() => setMode(null)} onRenamed={() => {
          setMode(null)
        }} />}
      <ConfirmDialog open={mode === 'delete'} title={t('chatSession.deleteTitle')}
        message={t('chatSession.deleteMessage', { title: session.title })} confirmText={t('chatSession.deleteConfirm')}
        danger loading={busy} onConfirm={() => { void remove() }}
        onCancel={() => { if (!busy) { setMode(null); clearSessionError() } }} />
      {sessionError && <div role="alert" className="layout-session-delete-error">
        <span>{sessionError}</span><Button variant="icon" aria-label={t('common.close')}
          className="layout-session-delete-error-close" onClick={clearSessionError}><Icon name="x" size={13} /></Button>
      </div>}
    </>, document.body)}
  </>
}
