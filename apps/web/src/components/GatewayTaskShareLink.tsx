import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { useI18n } from '../i18n'
import Icon from './Icon'

export default function GatewayTaskShareLink({ taskId, projectId }: { taskId: string; projectId: string | null }) {
  const session = useGatewaySessionStore(state => state.session)
  const { t } = useI18n()
  if (!session?.share_create || !session.project_id || session.host_project_id !== projectId) return null
  const url = new URL('/shares/new', session.gateway_url)
  url.search = new URLSearchParams({ project_id: session.project_id, task_id: taskId }).toString()
  return <a className="btn btn-ghost task-detail-share-button" href={url.toString()}
    title={t('taskDetail.shareButtonTitle')} aria-label={t('taskDetail.shareButtonTitle')}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <Icon name="share" size={13} strokeWidth={1.75} />
    <span className="task-detail-share-label">{t('share.dialogTitle')}</span>
  </a>
}
