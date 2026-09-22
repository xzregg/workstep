import type { CSSProperties } from 'react'

export interface SpinnerProps {
  size?: number
  className?: string
  style?: CSSProperties
}

/** 统一旋转加载图标（currentColor，随父级颜色） */
export default function Spinner({ size = 12, className, style }: SpinnerProps) {
  return (
    <span
      aria-hidden="true"
      className={['spinner', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, ...style }}
    />
  )
}
