import { Link, Route, Routes } from 'react-router-dom'
import { DesktopLoginPage } from './DesktopLoginPage'
import { DeviceAdminPage } from './DeviceAdminPage'
import { ClientDownloadPage } from './ClientDownloadPage'
import { DeviceListPage } from './DeviceListPage'
import { ProjectsPage } from './ProjectsPage'
import { ProjectWorkspacePage } from './ProjectWorkspacePage'

export function App({ deviceHost = typeof window !== 'undefined' && window.location.hostname.startsWith('d-') }: { deviceHost?: boolean }) {
  if (deviceHost) return <main><header><h1>WorkStep 远程项目</h1></header><ProjectWorkspacePage /></main>
  return (
    <main>
      <header><h1>WorkStep Gateway</h1><nav><Link to="/">我的项目</Link> <Link to="/devices">我的电脑</Link> <Link to="/admin">管理后台</Link></nav></header>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/admin" element={<section><h2>管理后台</h2><p>平台服务正在建设中。</p><Link to="/admin/devices">设备管理</Link></section>} />
        <Route path="/admin/devices" element={<DeviceAdminPage />} />
        <Route path="/devices/empty" element={<ClientDownloadPage />} />
        <Route path="/devices" element={<DeviceListPage />} />
        <Route path="/desktop/login" element={<DesktopLoginPage />} />
        <Route path="/auth/pending" element={<section className="gateway-auth-card">
          <h2>账号等待审核</h2><p>管理员批准后，请从桌面端重新发起登录。</p>
        </section>} />
        <Route path="*" element={<section><h2>页面不存在</h2><Link to="/">返回工作台</Link></section>} />
      </Routes>
    </main>
  )
}
