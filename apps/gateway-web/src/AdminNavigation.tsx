import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'

const modules = [
 { path: '/admin', label: '管理概览', roles: [] },
 { path: '/admin/users', label: '用户管理', roles: ['identity_admin', 'org_admin', 'department_admin'] },
 { path: '/admin/groups', label: '用户组管理', roles: ['super_admin'] },
 { path: '/admin/admins', label: '管理员权限', roles: ['org_admin'] },
 { path: '/admin/permissions', label: '权限管理', roles: ['super_admin'] },
 { path: '/admin/devices', label: '设备管理', roles: ['device_admin', 'org_admin', 'department_admin'] },
 { path: '/admin/device-groups', label: '设备组与部门', roles: ['super_admin'] },
 { path: '/admin/device-operations', label: '设备作业', roles: ['device_admin', 'org_admin', 'department_admin'] },
 { path: '/admin/projects', label: '项目管理', roles: ['org_admin', 'department_admin'] },
 { path: '/admin/shares', label: '分享管理', roles: ['super_admin'] },
 { path: '/admin/providers', label: '模型供应商', roles: ['org_admin', 'department_admin'] },
 { path: '/admin/skills', label: 'Skills 管理', roles: ['skill_admin'] },
 { path: '/admin/usage', label: '用量与对账', roles: ['audit_admin'] },
 { path: '/admin/audit', label: '审计记录', roles: ['audit_admin'] },
 { path: '/admin/settings', label: '平台设置', roles: ['super_admin'] },
]
const groups = [
 { title: '用户与权限', paths: ['/admin/users', '/admin/groups', '/admin/permissions', '/admin/admins'] },
 { title: '设备管理', paths: ['/admin/devices', '/admin/device-groups', '/admin/device-operations'] },
 { title: '资源管理', paths: ['/admin/projects', '/admin/shares', '/admin/providers', '/admin/skills'] },
 { title: '统计与审计', paths: ['/admin/usage', '/admin/audit'] },
 { title: '系统设置', paths: ['/admin/settings'] },
]

export function adminPageTitle(pathname: string): string {
 return modules.find(item => item.path === pathname)?.label ?? '平台管理'
}

export function AdminNavigation({ roles, onNavigate }: { roles: string[]; onNavigate?: () => void }) {
 const { pathname } = useLocation()
 const [expanded, setExpanded] = useState<Record<string, boolean>>({})
 return <nav aria-label="管理菜单">
  <NavLink to="/admin" end onClick={onNavigate}>管理概览</NavLink>
  {groups.map(group => {
   const visible = modules.filter(item => group.paths.includes(item.path) && (roles.includes('super_admin') || item.roles.some(role => roles.includes(role))))
   return visible.length > 0 && <details className="gateway-admin-nav-group" key={group.title} data-current={group.paths.includes(pathname) || undefined}
    open={expanded[group.title] ?? false} onToggle={event => {
     const open = event.currentTarget.open
     setExpanded(previous => previous[group.title] === open ? previous : { ...previous, [group.title]: open })
    }}>
    <summary>{group.title}</summary><div>{visible.map(item => <NavLink key={item.path} to={item.path} onClick={onNavigate}>{item.label}</NavLink>)}</div>
   </details>
  })}
 </nav>
}
