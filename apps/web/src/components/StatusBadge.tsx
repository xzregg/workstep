import type { ReactNode } from 'react'
import Spinner from './Spinner'

export interface StatusBadgeProps {
  status: string
  label?: ReactNode
  /** 异步处理中强制旋转加载图标；缺省按 status 推断 */
  loading?: boolean
  className?: string
}

const ASYNC_STATUSES = new Set([
  'running', 'reviewing', 'awaiting_review', 'retrying', 'rework', 'rework_waiting',
])

/** 状态徽标：语义色 + 「进行中/审核中」等异步状态自动附旋转加载图标 */
export default function StatusBadge({ status, label, loading, className }: StatusBadgeProps) {
  const busy = loading ?? ASYNC_STATUSES.has(status)
  return (
    <span className={['status-badge', className].filter(Boolean).join(' ')} data-s={status}>
      {busy && <Spinner size={10} />}
      {label}
    </span>
  )
}
