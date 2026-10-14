import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { Project } from '../api/client'
import { useManagedMode } from '../hooks/useManagedMode'
import { useI18n } from '../i18n'
import { canUseLocalTaskShare } from '../utils/taskShareUrl'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import Button from './Button'
import Icon from './Icon'
import ShareDialog from './ShareDialog'
import GatewayTaskShareLink from './GatewayTaskShareLink'

/** Choose the task's share transport once, without duplicating share buttons. */
export default function TaskShareButton({ taskId, projectId, projectType, taskTitle }: {
  taskId: string; projectId: string; projectType?: Project['type']; taskTitle?: string
}) {
  const managed = useManagedMode(projectType !== 'remote')
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  const { can } = useGatewayProjectPermissions(projectId)
  if (!projectId || (!can('share.create') && !can('share.manage'))) return null
  if (!canUseLocalTaskShare(managed, projectType)) return <GatewayTaskShareLink
    taskId={taskId} taskTitle={taskTitle} projectId={projectId} local={!isGatewayRemoteBrowser()} />
  if (managed === null && projectType !== 'remote') return null
  return <><Button className="task-detail-share-button" variant="ghost"
    title={t('taskDetail.shareButtonTitle')} aria-label={t('taskDetail.shareButtonTitle')}
    onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setOpen(true) }}>
    <Icon name="share" size={13} strokeWidth={1.75} />
    <span className="task-detail-share-label">{t('share.dialogTitle')}</span>
  </Button>
    {createPortal(<ShareDialog open={open} taskId={taskId} taskTitle={taskTitle} projectId={projectId} onClose={() => setOpen(false)} />, document.body)}
  </>
}
