import { useI18n } from '../i18n'
import './DeleteTaskConfirmation.css'

export default function ArchiveWorkspaceChoice({ checked, disabled, onChange }: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useI18n()
  return <label className="delete-task-workspace-choice">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <span>{t('taskList.archiveDeleteWorkspace')}</span>
  </label>
}
