import { Link, NavLink } from 'react-router-dom'

export function PortalHeader({ hasAdminAccess }: { hasAdminAccess: boolean }) {
 return <header className="gateway-portal-header">
  <h1>WORKSTEP <span>平台</span></h1>
  <nav className="gateway-portal-navigation" aria-label="工作台导航">
   <NavLink to="/" end>我的项目</NavLink>
   <NavLink to="/devices">我的电脑</NavLink>
   <NavLink to="/groups">用户组 Skills</NavLink>
   <NavLink className="gateway-portal-account" to="/account">个人账户</NavLink>
   {hasAdminAccess && <NavLink to="/admin">管理后台</NavLink>}
  </nav>
  <Link className="gateway-portal-sign-in" to="/auth">登录 / 注册</Link>
 </header>
}
