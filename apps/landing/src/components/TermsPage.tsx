import { useI18n } from '../i18n'
import { legalCopy } from '../i18n/legal'
import { RELEASES_URL } from '../config/downloads'
import { SupportLink } from './SupportLink'

export function TermsPage() {
  const { lang, t } = useI18n()
  const copy = legalCopy[lang]
  return <main className="legal-page container" lang={lang}>
    <a href="#top">{t('privacy.home')}</a>
    <h1>{copy.title}</h1>
    <time dateTime="2026-10-28">2026-10-28</time>
    <p>{copy.license}</p><p>{copy.responsibility}</p><p>{copy.warranty}</p>
    <p><a href="https://github.com/xzregg/workstep/blob/main/LICENSE" target="_blank" rel="noreferrer">Apache License 2.0</a> · <a href={RELEASES_URL}>{t('common.download')}</a> · <a href="#docs">{t('common.docs')}</a> · <a href="#privacy">{t('footer.privacy')}</a></p>
    <p><SupportLink /></p>
  </main>
}
