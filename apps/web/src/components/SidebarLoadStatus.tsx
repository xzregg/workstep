import { useI18n } from '../i18n'
import Spinner from './Spinner'
import './SidebarLoadStatus.css'

export default function SidebarLoadStatus({ loading, error, label, onRetry }: {
  loading?: boolean
  error?: string | null
  label: string
  onRetry?: () => void
}) {
  const { t } = useI18n()
  if (!loading && !error) return null
  return <div className="sidebar-load-status" role={error ? 'alert' : 'status'}>
    {loading ? <><Spinner size={14} /><span className="sidebar-load-status-text">{t('common.loading')}</span></> : <>
      <span className="sidebar-load-status-text" title={error ?? undefined}>{label}</span>
      {onRetry && <button type="button" onClick={onRetry}>{t('common.retry')}</button>}
    </>}
  </div>
}
