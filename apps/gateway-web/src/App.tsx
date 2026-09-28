import { Link, Route, Routes } from 'react-router-dom'
import { DesktopLoginPage } from './DesktopLoginPage'

export function App() {
  return (
    <main>
      <header><h1>WorkStep Gateway</h1><nav><Link to="/">工作台</Link> <Link to="/admin">管理后台</Link></nav></header>
      <Routes>
        <Route path="/" element={<section><h2>工作台</h2><p>平台服务正在建设中。</p></section>} />
        <Route path="/admin" element={<section><h2>管理后台</h2><p>平台服务正在建设中。</p></section>} />
        <Route path="/desktop/login" element={<DesktopLoginPage />} />
        <Route path="*" element={<section><h2>页面不存在</h2><Link to="/">返回工作台</Link></section>} />
      </Routes>
    </main>
  )
}
