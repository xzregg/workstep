import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'

const modules = [
 { path: '/admin', label: '管理概览', roles: [] },
 { path: '/admin/users', label: '用户管理', roles: ['identity_admin', 'org_admin', 'department_admin'] },
 { path: '/admin/org', label: '组织与同步', roles: ['identity_admin', 'org_admin', 'department_admin'] },
 { path: '/admin/admins', label: '管理员权限', roles: ['org_admin'] },
 { path: '/admin/devices', label: '设备管理', roles: ['device_admin', 'org_admin', 'department_admin'] },
 { path: '/admin/device-groups', label: '设备组与部门', roles: ['super_admin'] },
 { path: '/admin/device-operations', label: '设备作业', roles: ['device_admin', 'org_admin', 'department_admin'] },
 { path: '/admin/projects', label: '项目管理', roles: ['org_admin', 'department_admin'] },
 { path: '/admin/shares', label: '分享管理', roles: ['super_admin'] },
 { path: '/admin/providers', label: '模型供应商', roles: ['org_admin', 'department_admin'] },
 { path: '/admin/skills', label: 'Skills 管理', roles: ['skill_admin'] },
 { path: '/admin/groups', label: '用户组管理', roles: ['super_admin'] },
 { path: '/admin/usage', label: '用量与对账', roles: ['audit_admin'] },
 { path: '/admin/audit', label: '审计记录', roles: ['audit_admin'] },
 { path: '/admin/settings', label: '平台设置', roles: ['super_admin'] },
]

export function AdminLayout({ roles, children }: { roles: string[]; children: ReactNode }) {
 return <div className="gateway-admin-shell">
   <aside className="gateway-admin-sidebar">
     <Link className="gateway-admin-brand" to="/admin">WORKSTEP 平台</Link>
     <p className="gateway-admin-sidebar-label">管理后台</p>
     <nav aria-label="管理菜单">{modules.filter(item => roles.includes('super_admin') || item.roles.length === 0 || item.roles.some(role => roles.includes(role))).map(item =>
       <NavLink key={item.path} to={item.path} end={item.path === '/admin'}>{item.label}</NavLink>)}</nav>
     <Link className="gateway-admin-return" to="/">返回工作台</Link>
   </aside>
   <div className="gateway-admin-content"><div className="gateway-admin-topbar"><span>平台管理</span><Link to="/account">个人账户</Link></div>{children}</div>
 </div>
}
