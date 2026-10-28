import { legalCopy } from '../i18n/legal'
import { useI18n } from '../i18n'
import { SupportLink } from './SupportLink'

export function Footer() {
  const { t, lang } = useI18n()

  return (
    <footer className="footer">
      <div className="container footer-row">
        <div className="footer-brand">
          <span className="brand-mark-sm" />
          WorkStep
        </div>
        <div className="footer-tagline">{t('footer.tagline')}</div>
        <div className="footer-links">
          <a href="#docs">{t('common.docs')}</a>
          <a href="#features">{t('nav.features')}</a>
          <a href="#demos">{t('nav.demos')}</a>
          <a href="#privacy">{t('footer.privacy')}</a>
          <a href="https://github.com/xzregg/workstep/blob/main/LICENSE" target="_blank" rel="noreferrer">Apache License 2.0</a>
          <a href="#terms">{legalCopy[lang].title}</a>
          <SupportLink />
          <a href="https://github.com/xzregg/workstep" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <div className="footer-rights">{t('footer.rights')}</div>
      </div>
    </footer>
  )
}
