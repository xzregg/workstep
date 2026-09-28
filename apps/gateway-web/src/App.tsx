import { Link, Route, Routes } from 'react-router-dom'
import { DesktopLoginPage } from './DesktopLoginPage'
import { DeviceAdminPage } from './DeviceAdminPage'
import { ClientDownloadPage } from './ClientDownloadPage'
import { DeviceListPage } from './DeviceListPage'
import { ProjectsPage } from './ProjectsPage'
import { ProjectWorkspacePage } from './ProjectWorkspacePage'
import { PortalAuthPage } from './PortalAuthPage'
import { AccountPage } from './AccountPage'
import { AdminUsersPage } from './AdminUsersPage'
import { AdminRolesPage } from './AdminRolesPage'
import { AdminOverviewPage } from './AdminOverviewPage'
import { AdminAccessGate, useAdminAccess } from './AdminAccessGate'

export function App({ deviceHost = typeof window !== 'undefined' && window.location.hostname.startsWith('d-') }: { deviceHost?: boolean }) {
  if (deviceHost) return <main><header><h1>WorkStep 远程项目</h1></header><ProjectWorkspacePage /></main>
  return <GatewayPortalApp />
}

function GatewayPortalApp() {
  const adminAccess = useAdminAccess()
  const hasAdminAccess = adminAccess.status === 'ready' && !!adminAccess.access?.roles.length &&
    !adminAccess.access.must_change_password
  return (
    <main>
      <header><h1>WorkStep Gateway</h1><nav><Link to="/">我的项目</Link> <Link to="/devices">我的电脑</Link> <Link to="/account">个人账户</Link> {hasAdminAccess && <Link to="/admin">管理后台</Link>} <Link to="/auth">登录 / 注册</Link></nav></header>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/admin" element={<AdminAccessGate state={adminAccess}><AdminOverviewPage /></AdminAccessGate>} />
        <Route path="/admin/users" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin', 'identity_admin']}><AdminUsersPage /></AdminAccessGate>} />
        <Route path="/admin/admins" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin']}><AdminRolesPage /></AdminAccessGate>} />
        <Route path="/admin/devices" element={<AdminAccessGate state={adminAccess}
          allow={['super_admin']}><DeviceAdminPage /></AdminAccessGate>} />
        <Route path="/devices/empty" element={<ClientDownloadPage />} />
        <Route path="/devices" element={<DeviceListPage />} />
        <Route path="/desktop/login" element={<DesktopLoginPage />} />
        <Route path="/auth" element={<PortalAuthPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/auth/pending" element={<section className="gateway-auth-card">
          <h2>账号等待审核</h2><p>管理员批准后，请重新登录。</p><Link to="/auth">返回登录</Link>
        </section>} />
        <Route path="*" element={<section><h2>页面不存在</h2><Link to="/">返回工作台</Link></section>} />
      </Routes>
    </main>
  )
}
