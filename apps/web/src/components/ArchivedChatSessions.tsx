import { useEffect, useMemo, useState } from 'react'
import { chatSessionApi, type ChatSessionSummary } from '../api/client'
import { useI18n } from '../i18n'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Input from './Input'
import ResizablePanel from './ResizablePanel'

export default function ArchivedChatSessions({ projectId }: { projectId: string }) {
  const { t } = useI18n()
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deleteIds, setDeleteIds] = useState<string[]>([])

  useEffect(() => {
    let live = true
    setLoading(true)
    setSelected(new Set())
    setError('')
    void chatSessionApi.list(projectId, true).then(({ sessions: result }) => {
      if (live) setSessions(result)
    }).catch((reason) => {
      if (live) setError(reason instanceof Error ? reason.message : t('chatSession.archiveLoadFailed'))
    }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [projectId, t])

  const visible = useMemo(() => sessions.filter((session) =>
    session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    || session.preview?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  ), [sessions, query])
  const visibleIds = visible.map((session) => session.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

  const restore = async (ids: string[]) => {
    if (busy || !ids.length) return
    setBusy(true)
    setError('')
    try {
      for (const id of ids) {
        const session = await chatSessionApi.setArchived(id, projectId, false)
        setSessions((current) => current.filter((item) => item.id !== id))
        setSelected((current) => new Set([...current].filter((item) => item !== id)))
        useChatListStore.getState().addSession(session)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('chatSession.restoreFailed'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy || !deleteIds.length) return
    setBusy(true)
    setError('')
    try {
      const result = await chatSessionApi.bulkDelete(projectId, deleteIds)
      const deleted = new Set(result.deleted)
      setSessions((current) => current.filter((session) => !deleted.has(session.id)))
      setSelected((current) => new Set([...current].filter((id) => !deleted.has(id))))
      result.deleted.forEach((id) => useChatSessionStore.getState().resetSession(id))
      if (result.skipped.length) setError(t('chatSession.archiveSkipped', { count: result.skipped.length }))
      setDeleteIds([])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('chatSession.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Input
      value={query}
      onChange={(event) => setQuery(event.target.value)}
      placeholder={t('chatSession.searchArchive')}
      aria-label={t('chatSession.searchArchive')}
    />
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <input type="checkbox" checked={allVisibleSelected} disabled={!visibleIds.length || busy}
          onChange={() => setSelected((current) => {
            const next = new Set(current)
            visibleIds.forEach((id) => { if (allVisibleSelected) next.delete(id); else next.add(id) })
            return next
          })} />
        {t('chatSession.selectAllArchive')}
      </label>
      <Button variant="ghost" disabled={!selected.size || busy} loading={busy}
        onClick={() => void restore([...selected])}>{t('chatSession.restoreSelected')}</Button>
      <Button variant="ghost" disabled={!selected.size || busy}
        onClick={() => setDeleteIds([...selected])}>{t('chatSession.deleteSelected')}</Button>
    </div>
    {error && <div role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}
    {loading ? <div>{t('common.loading')}</div> : visible.length === 0 ? (
      <div style={{ color: 'var(--muted)' }}>{t('chatSession.archiveEmpty')}</div>
    ) : visible.map((session) => <div key={session.id} style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
      border: '1px solid var(--border-soft)', borderRadius: 8,
    }}>
      <input type="checkbox" checked={selected.has(session.id)} disabled={busy}
        aria-label={t('chatSession.selectArchive', { title: session.title })}
        onChange={() => setSelected((current) => {
          const next = new Set(current)
          if (next.has(session.id)) next.delete(session.id); else next.add(session.id)
          return next
        })} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.title}</div>
        {session.preview && <div style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{session.preview}</div>}
      </div>
      <Button variant="ghost" disabled={busy} onClick={() => void restore([session.id])}>{t('chatSession.restore')}</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setDeleteIds([session.id])}>{t('common.delete')}</Button>
    </div>)}
    <ConfirmDialog open={deleteIds.length > 0} title={t('chatSession.deleteTitle')}
      message={t('chatSession.archiveDeleteMessage', { count: deleteIds.length })}
      confirmText={t('chatSession.deleteConfirm')} danger loading={busy}
      onConfirm={() => void remove()} onCancel={() => { if (!busy) setDeleteIds([]) }} />
  </div>
}

export function ArchivedChatSessionsDialog({ projectId, projectName, onClose }: {
  projectId: string
  projectName: string
  onClose: () => void
}) {
  const { t } = useI18n()
  return <div className="modal-overlay" onClick={onClose}>
    <ResizablePanel className="modal" role="dialog" aria-modal="true"
      aria-label={`${t('chatSession.viewArchive')} · ${projectName}`}
      style={{ width: 760, height: '72vh', padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      onClick={(event) => event.stopPropagation()}>
      <div className="modal-header" style={{ flexShrink: 0, paddingLeft: 20 }}>
        <span className="modal-title">{t('chatSession.viewArchive')} · {projectName}</span>
        <Button variant="icon" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        <ArchivedChatSessions projectId={projectId} />
      </div>
    </ResizablePanel>
  </div>
}
