import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AdminNavigation, adminPageTitle } from './AdminNavigation'

function AdminBrand({ onNavigate }: { onNavigate?: () => void }) {
 return <Link className="gateway-admin-brand" to="/admin" onClick={onNavigate}><span className="gateway-admin-brand-mark" aria-hidden="true">W</span><span>WORKSTEP<span className="gateway-admin-brand-caption">平台管理后台</span></span></Link>
}

export function AdminLayout({ roles, children }: { roles: string[]; children: ReactNode }) {
 const { pathname } = useLocation()
 const menu = useRef<HTMLDialogElement>(null)
 const [menuOpen, setMenuOpen] = useState(false)
 const closeMenu = () => { menu.current?.close(); setMenuOpen(false) }
 useEffect(() => {
  if (!menuOpen || !window.matchMedia) return
  const desktop = window.matchMedia('(min-width: 1024px)')
  const closeOnDesktop = () => { if (desktop.matches) { menu.current?.close(); setMenuOpen(false) } }
  desktop.addEventListener('change', closeOnDesktop)
  closeOnDesktop()
  return () => desktop.removeEventListener('change', closeOnDesktop)
 }, [menuOpen])
 return <div className="gateway-admin-shell">
   <aside className="gateway-admin-sidebar gateway-admin-desktop-sidebar">
     <AdminBrand />
     <p className="gateway-admin-sidebar-label">工作空间</p>
     <AdminNavigation roles={roles} />
     <Link className="gateway-admin-return" to="/">返回工作台<span aria-hidden="true">↗</span></Link>
   </aside>
   <div className="gateway-admin-content">
    <header className="gateway-admin-topbar">
     <div className="gateway-admin-topbar-heading">
      <button className="gateway-admin-menu-trigger" type="button" aria-label="打开管理菜单" aria-controls="gateway-admin-mobile-menu" aria-expanded={menuOpen} onClick={() => { menu.current?.showModal(); setMenuOpen(true) }}><span className="gateway-admin-menu-icon" aria-hidden="true" /></button>
      <div className="gateway-admin-breadcrumb"><span>管理后台</span><span aria-hidden="true">/</span><strong>{adminPageTitle(pathname)}</strong></div>
     </div>
     <Link className="gateway-admin-account" to="/account">个人账户</Link>
    </header>
    {children}
   </div>
   <dialog id="gateway-admin-mobile-menu" ref={menu} className="gateway-admin-mobile-menu" aria-label="移动端管理菜单" onClose={() => setMenuOpen(false)} onClick={event => { if (event.target === event.currentTarget) closeMenu() }}>
    <div className="gateway-admin-sidebar">
     <div className="gateway-admin-mobile-menu-header"><AdminBrand onNavigate={closeMenu} /><button type="button" className="gateway-admin-menu-close" aria-label="关闭管理菜单" onClick={closeMenu}><span aria-hidden="true">×</span></button></div>
     <p className="gateway-admin-sidebar-label">工作空间</p>
     <AdminNavigation roles={roles} onNavigate={closeMenu} />
     <Link className="gateway-admin-return" to="/" onClick={closeMenu}>返回工作台<span aria-hidden="true">↗</span></Link>
    </div>
   </dialog>
 </div>
}
