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
     <nav aria-label="管理菜单">
      <NavLink to="/admin" end>管理概览</NavLink>
      {[
       { title: '用户与权限', paths: ['/admin/users', '/admin/groups', '/admin/org', '/admin/admins'] },
       { title: '设备管理', paths: ['/admin/devices', '/admin/device-groups', '/admin/device-operations'] },
       { title: '资源管理', paths: ['/admin/projects', '/admin/shares', '/admin/providers', '/admin/skills'] },
       { title: '统计与审计', paths: ['/admin/usage', '/admin/audit'] },
       { title: '系统设置', paths: ['/admin/settings'] },
      ].map(group => {
       const visible = modules.filter(item => group.paths.includes(item.path) && (roles.includes('super_admin') || item.roles.some(role => roles.includes(role))))
       return visible.length > 0 && <details className="gateway-admin-nav-group" key={group.title} open>
        <summary>{group.title}</summary><div>{visible.map(item => <NavLink key={item.path} to={item.path}>{item.path === '/admin/org' ? '组织目录' : item.label}</NavLink>)}</div>
       </details>
      })}
     </nav>
     <Link className="gateway-admin-return" to="/">返回工作台</Link>
   </aside>
   <div className="gateway-admin-content"><div className="gateway-admin-topbar"><span>平台管理</span><Link to="/account">个人账户</Link></div>{children}</div>
 </div>
}
