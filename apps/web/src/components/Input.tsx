import { forwardRef, type InputHTMLAttributes } from 'react'

export type InputProps = InputHTMLAttributes<HTMLInputElement>

/** 统一输入框（样式随全局 input tokens，新增调整改此处） */
export default forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={['ws-input', className].filter(Boolean).join(' ')} {...rest} />
})
