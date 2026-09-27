import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import Icon, { type IconName } from './Icon'
import './SidebarActionMenu.css'

export const SidebarActionMenu = forwardRef<HTMLDivElement, {
  x: number
  y: number
  children: ReactNode
}>(function SidebarActionMenu({ x, y, children }, ref) {
  return (
    <div
      ref={ref}
      className="sidebar-action-menu"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
})

export function SidebarActionItem({ icon, danger = false, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName
  danger?: boolean
}) {
  return (
    <button type="button" className="sidebar-action-item" data-danger={danger || undefined} {...props}>
      <Icon name={icon} size={14} />
      {children}
    </button>
  )
}
