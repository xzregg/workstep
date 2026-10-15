import { useLocation, useNavigate } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useI18n } from '../i18n'
import type { SettingsSection } from '../pages/SettingsPage'
import Button from './Button'
import Icon, { type IconName } from './Icon'
import ScheduleCenter from './ScheduleCenter'

export const WORKSPACE_TOOL_RAIL_WIDTH = 48

interface Props {
  onOpenSettings: (section: SettingsSection) => void
  activeSettingsSection?: SettingsSection
}

/** One set of actions: desktop tool rail and compact mobile footer. */
export default function WorkspaceNavigationActions({ onOpenSettings, activeSettingsSection }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const projectId = useProjectStore(state => state.activeProject?.id)
  const { bound, can } = useGatewayProjectPermissions(projectId)
  const action = (label: string, icon: IconName, onClick: () => void, active = false, extra = '') => (
    <Button variant="ghost" className={`layout-sidebar-nav-button ${extra}`} aria-label={label}
      aria-current={active ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} size={17} strokeWidth={2} /><span className="layout-sidebar-action-label">{label}</span>
    </Button>
  )
  return <nav className="layout-sidebar-actions" aria-label={t('mobile.navigation')}>
    {can('statistics.read') && action(t('nav.statistics'), 'bar-chart', () => navigate('/statistics'), pathname === '/statistics')}
    <ScheduleCenter />
    {!bound && action(t('roleCenter.title'), 'drama', () => onOpenSettings('roles'), activeSettingsSection === 'roles', 'layout-sidebar-external-only')}
    {action(t('skins.appearance'), 'sparkles', () => bound ? navigate('/appearance') : onOpenSettings('appearance'),
      bound ? pathname === '/appearance' : activeSettingsSection === 'appearance',
      bound ? 'layout-sidebar-settings-button layout-sidebar-appearance' : 'layout-sidebar-external-only layout-sidebar-appearance')}
    {!bound && action(t('nav.settings'), 'settings', () => onOpenSettings('providers'),
      !!activeSettingsSection && !['appearance', 'roles'].includes(activeSettingsSection), 'layout-sidebar-settings-button')}
  </nav>
}
