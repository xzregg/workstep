import { Link, Route, Routes, useLocation } from 'react-router-dom'
import { AdminLayout } from './AdminLayout'
import { PortalHeader } from './PortalHeader'
import { DesktopLoginPage } from './DesktopLoginPage'
import { AdminDeviceGroupsPage } from './AdminDeviceGroupsPage'
import { DeviceAdminPage } from './DeviceAdminPage'
import { ClientDownloadPage } from './ClientDownloadPage'
import { DeviceListPage } from './DeviceListPage'
import { ProjectsPage } from './ProjectsPage'
import { PortalAuthPage } from './PortalAuthPage'
import { AccountPage } from './AccountPage'
import { AdminUsersPage } from './AdminUsersPage'
import { AdminRolesPage } from './AdminRolesPage'
import { AdminOverviewPage } from './AdminOverviewPage'
import { AdminAccessGate, useAdminAccess } from './AdminAccessGate'
import { AdminOrgPage } from './AdminOrgPage'
import { AdminDeviceOperationsPage } from './AdminDeviceOperationsPage'
import { AdminProjectsPage } from './AdminProjectsPage'
import { AdminProvidersPage } from './AdminProvidersPage'
import { AdminScopedProviderAssignmentsPage } from './AdminScopedProviderAssignmentsPage'
import { AdminUsagePage } from './AdminUsagePage'
import { AdminAuditPage } from './AdminAuditPage'
import { AdminPlatformSettingsPage } from './AdminPlatformSettingsPage'
import { GroupSkillsPage } from './GroupSkillsPage'
import { AdminSkillsPage } from './AdminSkillsPage'
import { AdminGroupsPage } from './AdminGroupsPage'
import { PublicSharePage } from './PublicSharePage'
import { GatewayShareCreatePage } from './GatewayShareCreatePage'
import { AdminSharesPage } from './AdminSharesPage'
import { RegistrationPendingPage } from './RegistrationPendingPage'

export function App({ deviceHost = typeof window !== 'undefined' && window.location.hostname.startsWith('d-') }: { deviceHost?: boolean }) {
  const location = useLocation()
  if (deviceHost) return <main><h1>WorkStep 远程项目</h1><p role="alert">请从平台重新打开远程项目。</p></main>
  if (location.pathname.startsWith('/share/')) return <Routes><Route path="/share/:token" element={<PublicSharePage />} /></Routes>
  return <GatewayPortalApp />
}

function GatewayPortalApp() {
  const location = useLocation()
  const adminAccess = useAdminAccess()
  const hasAdminAccess = adminAccess.status === 'ready' && !!adminAccess.access?.roles.length &&
    !adminAccess.access.must_change_password
  return (
    <main>
      {!location.pathname.startsWith('/admin') && <PortalHeader hasAdminAccess={hasAdminAccess} />}
      <AdminPortalRegion admin={location.pathname.startsWith('/admin')} roles={adminAccess.access?.roles ?? []}>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/groups" element={<GroupSkillsPage />} />
        <Route path="/admin" element={<AdminAccessGate state={adminAccess}><AdminOverviewPage /></AdminAccessGate>} />
        <Route path="/admin/users" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'identity_admin', 'org_admin', 'department_admin']}><AdminUsersPage /></AdminAccessGate>} />
        <Route path="/admin/org" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'identity_admin', 'org_admin', 'department_admin']}><AdminOrgPage roles={adminAccess.access?.roles ?? []} /></AdminAccessGate>} />
        <Route path="/admin/admins" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'org_admin']}><AdminRolesPage delegated={!adminAccess.access?.roles.includes('super_admin')} /></AdminAccessGate>} />
        <Route path="/admin/devices" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'device_admin', 'org_admin', 'department_admin']}><DeviceAdminPage /></AdminAccessGate>} />
        <Route path="/admin/device-groups" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin']}><AdminDeviceGroupsPage /></AdminAccessGate>} />
        <Route path="/admin/device-operations" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'device_admin', 'org_admin', 'department_admin']}><AdminDeviceOperationsPage /></AdminAccessGate>} />
        <Route path="/admin/projects" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'org_admin', 'department_admin']}><AdminProjectsPage /></AdminAccessGate>} />
        <Route path="/admin/shares" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin']}><AdminSharesPage /></AdminAccessGate>} />
        <Route path="/admin/providers" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'org_admin', 'department_admin']}>{adminAccess.access?.roles.includes('super_admin')
            ? <AdminProvidersPage /> : <AdminScopedProviderAssignmentsPage />}</AdminAccessGate>} />
        <Route path="/admin/skills" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'skill_admin']}><AdminSkillsPage /></AdminAccessGate>} />
        <Route path="/admin/groups" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin']}><AdminGroupsPage /></AdminAccessGate>} />
        <Route path="/admin/usage" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'audit_admin']}><AdminUsagePage readOnly={!adminAccess.access?.roles.includes('super_admin')} /></AdminAccessGate>} />
        <Route path="/admin/audit" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'audit_admin']}><AdminAuditPage /></AdminAccessGate>} />
        <Route path="/admin/settings" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin']}><AdminPlatformSettingsPage /></AdminAccessGate>} />
        <Route path="/devices/empty" element={<ClientDownloadPage />} />
        <Route path="/devices" element={<DeviceListPage />} />
        <Route path="/shares/new" element={<GatewayShareCreatePage />} />
        <Route path="/desktop/login" element={<DesktopLoginPage />} />
        <Route path="/auth" element={<PortalAuthPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/auth/pending" element={<RegistrationPendingPage />} />
        <Route path="*" element={<section><h2>页面不存在</h2><Link to="/">返回工作台</Link></section>} />
      </Routes>
      </AdminPortalRegion>
    </main>
  )
}

function AdminPortalRegion({ admin, roles, children }: { admin: boolean; roles: string[]; children: import('react').ReactNode }) {
 return admin ? <AdminLayout roles={roles}>{children}</AdminLayout> : <>{children}</>
}
