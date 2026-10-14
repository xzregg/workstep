import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
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

export default function GatewayTaskShareLink({ taskId, projectId, taskTitle, local = false }: { taskId: string; projectId: string | null; taskTitle?: string; local?: boolean }) {
  const session = useGatewaySessionStore(state => state.session)
  const [target, setTarget] = useState<{ projectId: string; source: GatewayRemoteSession; session: GatewayRemoteSession } | null>(null)
  useEffect(() => {
    if (local || !session || session.host_project_id || !projectId) return
    let cancelled = false
    request<GatewayRemoteSession>(`/remote/session?project_id=${encodeURIComponent(projectId)}`)
      .then(result => { if (!cancelled) setTarget({ projectId, source: session, session: result }) })
      .catch(() => { if (!cancelled) setTarget(null) })
    return () => { cancelled = true }
  }, [session, projectId, local])
  const sameIdentity = session && target && session.device_id === target.source.device_id && session.user_id === target.source.user_id && session.username === target.source.username
  const shareSession = session?.host_project_id ? session : sameIdentity && target?.projectId === projectId ? target.session : null
  const [open, setOpen] = useState(false)
  const hostProject = !local && !session?.host_project_id
  const platformProjectId = local || hostProject ? projectId : shareSession?.project_id
  const api = useMemo(() => platformProjectId ? createGatewayTaskShareApi(platformProjectId, local, hostProject) : null, [platformProjectId, local, hostProject])
  const { t } = useI18n()
  const { can } = useGatewayProjectPermissions(projectId || undefined)
  if ((!can('share.create') && !can('share.manage')) || !projectId || (!local && (!shareSession?.share_create || !platformProjectId || shareSession.host_project_id !== projectId))) return null
  return <><Button className="task-detail-share-button" variant="ghost"
    title={t('taskDetail.shareButtonTitle')} aria-label={t('taskDetail.shareButtonTitle')}
    onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setOpen(true) }}>
    <Icon name="share" size={13} strokeWidth={1.75} />
    <span className="task-detail-share-label">{t('share.dialogTitle')}</span>
  </Button>
    {api && projectId && createPortal(<ShareDialog key={`${platformProjectId}:${taskId}`} open={open} taskId={taskId} taskTitle={taskTitle} projectId={projectId}
      api={api} gateway onClose={() => setOpen(false)} />, document.body)}
  </>
}
