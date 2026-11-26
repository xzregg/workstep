import './ConfirmDialog.css'
import ResizablePanel from './ResizablePanel'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import { useRef, type ReactNode } from 'react'
import Button from './Button'
import Icon from './Icon'
import { useI18n } from '../i18n'

interface Props {
  open: boolean
  title: string
  message?: string
  confirmText?: string
  noConfirm?: boolean
  hideFooter?: boolean
  cancelText?: string
  secondaryText?: string
  danger?: boolean
  /** Optional body content rendered below the message (e.g. forms). */
  children?: ReactNode
  /** Disable the confirm button while an async action is in flight. */
  loading?: boolean
  /** Disable confirmation until the dialog content is valid. */
  confirmDisabled?: boolean
  secondaryLoading?: boolean
  secondaryDisabled?: boolean
  /** Override the default dialog width (px). */
  width?: number
  zIndex?: number
  className?: string
  showClose?: boolean
  onConfirm: () => void
  onSecondary?: () => void
  onCancel: () => void
}

export default function ConfirmDialog({ open, title, message, confirmText, noConfirm, hideFooter, cancelText, secondaryText, danger, children, loading, confirmDisabled, secondaryLoading, secondaryDisabled, width = 380, zIndex = 2000, className, showClose=false, onConfirm, onSecondary, onCancel }: Props) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const dialogRef = useRef<HTMLDivElement>(null)
  useOverlay(open, onCancel, dialogRef, compact)

  if (!open) return null

  return (
    <div
      onClick={onCancel}
      className="confirm-dialog-backdrop"
      style={{ zIndex }}
    >
      <ResizablePanel
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={['confirm-dialog-panel',className].filter(Boolean).join(' ')}
        style={{ width }}
      >
        {/* Header */}
        <div data-dialog-drag-handle className={`confirm-dialog-header${showClose?' confirm-dialog-header--closable':''}`}>
          <div className="confirm-dialog-title">
            {title}
          </div>
          {message && (
            <div className="confirm-dialog-message">
              {message}
            </div>
          )}
          {showClose&&<Button variant="icon" aria-label={t('common.close')} onClick={onCancel}><Icon name="x"/></Button>}
        </div>

        {children && (
          <div
            data-confirm-dialog-body="true"
            className="confirm-dialog-body"
          >
            {children}
          </div>
        )}

        {/* Footer */}
        {!hideFooter && <div className="confirm-dialog-footer">
          <Button variant="ghost" onClick={onCancel}>{cancelText ?? t('common.cancel')}</Button>
          {!noConfirm && <Button
            variant={danger ? 'danger' : 'primary'}
            loading={loading}
            disabled={confirmDisabled}
            onClick={onConfirm}
            className="confirm-dialog-confirm"
          >
            {confirmText ?? t('common.confirm')}
          </Button>}
          {secondaryText && onSecondary && (
            <Button
              variant="ghost"
              loading={secondaryLoading}
              disabled={secondaryDisabled}
              onClick={onSecondary}
            >
              {secondaryText}
            </Button>
          )}
        </div>}
      </ResizablePanel>
    </div>
  )
}
