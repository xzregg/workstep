import { useI18n } from '../i18n'
import './ProjectStorageField.css'

export default function ProjectStorageField({ value, onChange, disabled, path }: {
  value: boolean; onChange: (value: boolean) => void; disabled?: boolean; path?: string
}) {
  const { t } = useI18n()
  return <div className="project-storage-field">
    <label className="project-storage-label">
      <button type="button" className="settings-switch" role="switch"
        aria-label={t('projectStorage.follow')} aria-checked={value}
        disabled={disabled} onClick={() => onChange(!value)}>
        <span className="settings-switch-thumb" />
      </button>
      <span>{t('projectStorage.follow')}</span>
    </label>
    <p>{t(value ? 'projectStorage.localHint' : 'projectStorage.homeHint')}</p>
    {path && <code className="project-storage-path">{path}</code>}
    {!value && <p>{t('projectStorage.moveHint')}</p>}
  </div>
}
