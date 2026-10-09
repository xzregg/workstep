import { useI18n } from '../i18n'

export default function AppLoading() {
  const { t } = useI18n()
  return <div className="app-loading" role="status"><span className="app-loading-spinner" aria-hidden="true" />{t('common.loading')}</div>
}
