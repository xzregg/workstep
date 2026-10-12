import type { ReactNode } from 'react'
import { useProjectStore } from '../stores/projectStore'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useI18n } from '../i18n'
import './ProjectPermissionGate.css'
/** Prevents a manually entered route from mounting an unavailable project feature. */
export function ProjectPermissionGate({ permission, children }: { permission: string; children: ReactNode }) {
  const projectId = useProjectStore(state => state.activeProject?.id)
  const { can } = useGatewayProjectPermissions(projectId)
  const { t } = useI18n()
  return can(permission) ? children : <div className="project-permission-unavailable" role="status">{t('common.featureUnavailable')}</div>
}
