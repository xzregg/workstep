import { forwardRef, type TextareaHTMLAttributes } from 'react'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

/** 统一多行输入（样式随全局 textarea tokens） */
export default forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={['ws-textarea', className].filter(Boolean).join(' ')} {...rest} />
})
