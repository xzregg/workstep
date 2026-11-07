import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes } from 'react'
import Spinner from './Spinner'

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'icon'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

function buttonClasses(variant: ButtonVariant, size: ButtonSize, className?: string, loading = false) {
  return [
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
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: Exclude<ButtonVariant, 'icon'>
  size?: ButtonSize
}

/** 导航和下载入口复用按钮样式，保留链接原生行为。 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant = 'ghost', size = 'md', className, children, ...rest }, ref,
) {
  return <a ref={ref} className={buttonClasses(variant, size, className)} {...rest}>{children}</a>
})

/** 统一按钮：primary / ghost / danger / icon，支持 loading 态 */
export default forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', loading = false, disabled, className, children, ...rest },
  ref,
) {
  const classes = buttonClasses(variant, size, className, loading)
  return (
    <button ref={ref} className={classes} disabled={disabled || loading} {...rest} aria-busy={loading || rest['aria-busy']}>
      {loading && <Spinner size={12} />}
      {children}
    </button>
  )
})
