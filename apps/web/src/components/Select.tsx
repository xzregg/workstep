import { forwardRef, type SelectHTMLAttributes } from 'react'

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>

/** 统一下拉选择（样式随全局 select tokens） */
export default forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, ...rest },
  ref,
) {
  return <select ref={ref} className={['ws-select', className].filter(Boolean).join(' ')} {...rest} />
})
