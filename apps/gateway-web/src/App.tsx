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

export function App({ deviceHost = typeof window !== 'undefined' && window.location.hostname.startsWith('d-') }: { deviceHost?: boolean }) {
  if (deviceHost) return <main><header><h1>WorkStep 远程项目</h1></header><ProjectWorkspacePage /></main>
  return (
    <main>
      <header><h1>WorkStep Gateway</h1><nav><Link to="/">我的项目</Link> <Link to="/devices">我的电脑</Link> <Link to="/account">个人账户</Link> <Link to="/admin">管理后台</Link> <Link to="/auth">登录 / 注册</Link></nav></header>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/admin" element={<section className="gateway-admin-page"><h2>管理后台</h2>
          <p>管理 Gateway 用户和受管设备。</p><nav className="gateway-admin-links">
            <Link to="/">返回工作台</Link><Link to="/admin/users">用户管理</Link><Link to="/admin/devices">设备管理</Link>
          </nav></section>} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/admin/devices" element={<DeviceAdminPage />} />
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
