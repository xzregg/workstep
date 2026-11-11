import { languageDirection, useI18n } from '../i18n'
import { acceptableUseCopy } from '../i18n/acceptableUse'
import { legalCopy } from '../i18n/legal'
import { SupportLink } from './SupportLink'

export function AcceptableUsePage() {
  const { lang, t } = useI18n()
  const copy = acceptableUseCopy[lang]
  return <main className="legal-page container" lang={lang} dir={languageDirection(lang)}>
    <a href="#top">{t('privacy.home')}</a>
    <h1>{copy.title}</h1>
    <time dateTime="2026-11-06">2026-11-06</time>
    <p>{copy.intro}</p>
    <h2>{copy.prohibitedTitle}</h2>
    <ul>{copy.prohibited.map(item => <li key={item}>{item}</li>)}</ul>
    <h2>{copy.reviewTitle}</h2>
    <p>{copy.review}</p>
    <h2>{copy.reportsTitle}</h2>
    <p>{copy.reports}</p>
    <p>{copy.services}</p>
    <p><SupportLink /></p>
    <p><a href="#terms">{legalCopy[lang].title}</a> · <a href="#privacy">{t('footer.privacy')}</a> · <a href="https://github.com/xzregg/workstep/blob/main/LICENSE" target="_blank" rel="noreferrer">Apache License 2.0</a></p>
  </main>
}
