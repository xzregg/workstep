import { forwardRef, type ButtonHTMLAttributes } from 'react'
import Spinner from './Spinner'

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'icon'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

/** 统一按钮：primary / ghost / danger / icon，支持 loading 态 */
export default forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', loading = false, disabled, className, children, ...rest },
  ref,
) {
  const classes = [
    'btn',
    variant === 'primary'
      ? 'btn-primary'
      : variant === 'danger'
        ? 'btn-danger'
        : variant === 'icon'
          ? 'btn-icon'
          : 'btn-ghost',
    size === 'sm' ? 'btn-sm' : '',
    loading ? 'btn-loading' : '',
    className ?? '',
  ].filter(Boolean).join(' ')
  return (
    <button ref={ref} className={classes} disabled={disabled || loading} {...rest}>
      {loading && <Spinner size={12} />}
      {children}
    </button>
  )
})
