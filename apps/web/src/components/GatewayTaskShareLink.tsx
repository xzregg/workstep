import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { useI18n } from '../i18n'
import Icon from './Icon'
import Button from './Button'
import { createPortal } from 'react-dom'
import ShareDialog from './ShareDialog'
import { createGatewayTaskShareApi } from '../api/gatewayTaskShare'
import { useEffect, useState, useMemo } from 'react'
import { request } from '../api/transport'
import type { GatewayRemoteSession } from '../stores/gatewaySessionStore'

export default function GatewayTaskShareLink({ taskId, projectId }: { taskId: string; projectId: string | null }) {
  const session = useGatewaySessionStore(state => state.session)
  const [target, setTarget] = useState<{ projectId: string; source: GatewayRemoteSession; session: GatewayRemoteSession } | null>(null)
  useEffect(() => {
    if (!session || session.host_project_id || !projectId) return
    let cancelled = false
    request<GatewayRemoteSession>(`/remote/session?project_id=${encodeURIComponent(projectId)}`)
      .then(result => { if (!cancelled) setTarget({ projectId, source: session, session: result }) })
      .catch(() => { if (!cancelled) setTarget(null) })
    return () => { cancelled = true }
  }, [session, projectId])
  const shareSession = session?.host_project_id ? session : session && target?.source === session && target.projectId === projectId ? target.session : null
  const [open, setOpen] = useState(false)
  const platformProjectId = shareSession?.project_id
  const api = useMemo(() => platformProjectId ? createGatewayTaskShareApi(platformProjectId) : null, [platformProjectId])
  const { t } = useI18n()
  if (!shareSession?.share_create || !shareSession.project_id || shareSession.host_project_id !== projectId) return null
  return <><Button className="task-detail-share-button" variant="ghost"
    title={t('taskDetail.shareButtonTitle')} aria-label={t('taskDetail.shareButtonTitle')}
    onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setOpen(true) }}>
    <Icon name="share" size={13} strokeWidth={1.75} />
    <span className="task-detail-share-label">{t('share.dialogTitle')}</span>
  </Button>
    {api && projectId && createPortal(<ShareDialog key={`${platformProjectId}:${taskId}`} open={open} taskId={taskId} projectId={projectId}
      api={api} gateway onClose={() => setOpen(false)} />, document.body)}
  </>
}
