import ConfirmDialog from './ConfirmDialog'
import { useI18n } from '../i18n'
import type { WorkflowExecutionWarning } from '../utils/workflowExecutionWarnings'

export default function WorkflowExecutionWarningDialog({
  warnings,
  onConfirm,
  onCancel,
  confirmText,
}: {
  warnings: WorkflowExecutionWarning[]
  onConfirm: () => void
  onCancel: () => void
  confirmText?: string
}) {
  const { t } = useI18n()
  return (
    <ConfirmDialog
      open={warnings.length > 0}
      title={t('flow.executionWarningTitle')}
      message={t('flow.executionWarningIntro')}
      confirmText={confirmText ?? t('flow.executionWarningSave')}
      width={520}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <ul style={{ margin: '12px 0 0', paddingLeft: 20, fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.6 }}>
        {warnings.map((warning) => (
          <li key={warning.target}>
            {t('flow.executionWarningItem', { target: warning.target })}
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  )
}
