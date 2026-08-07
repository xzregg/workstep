import type { ReactNode } from 'react'

export interface FieldProps {
  label?: ReactNode
  htmlFor?: string
  required?: boolean
  /** 帮助文本（正常态，灰色） */
  help?: ReactNode
  /** 错误提示（danger 色），与 help 互斥显示 */
  error?: ReactNode
  children: ReactNode
  className?: string
}

/** 表单字段：label + 控件 + 固定高度提示区（错误/帮助占位，避免布局跳动） */
export default function Field({ label, htmlFor, required, help, error, children, className }: FieldProps) {
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      {label && (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
          {required && <span className="field-required" aria-hidden="true">*</span>}
        </label>
      )}
      {children}
      <div className="field-hint" aria-live="polite">
        {error ? <span className="field-error">{error}</span> : help ? <span className="field-help">{help}</span> : null}
      </div>
    </div>
  )
}
