import { useI18n } from '../i18n'
import { editorialCopy } from '../i18n/editorial'
import { SupportLink } from './SupportLink'

export function PrivacyPage() {
  const { t, lang } = useI18n()
  return <main className="privacy-page container" lang={lang}>
    <a href="#top">{t('privacy.home')}</a>
    <h1>{t('privacy.title')}</h1>
    <p>{t('privacy.localData')}</p>
    <p>{t('privacy.externalServices')}</p>
    <p>{editorialCopy[lang].supportNotice}</p>
    <p><SupportLink /></p>
  </main>
}
