import { useI18n } from '../i18n'

export function PrivacyPage() {
  const { t } = useI18n()
  return <main className="privacy-page container">
    <a href="#top">{t('privacy.home')}</a>
    <h1>{t('privacy.title')}</h1>
    <p>{t('privacy.localData')}</p>
    <p>{t('privacy.externalServices')}</p>
  </main>
}
