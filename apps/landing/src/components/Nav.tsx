import { Download } from 'lucide-react'
import { useI18n, type Lang } from '../i18n'

interface NavProps {
  onOpenDownload: () => void
}

export function Nav({ onOpenDownload }: NavProps) {
  const { t, lang, setLang } = useI18n()
  const otherLang: Lang = lang === 'zh-CN' ? 'en-US' : 'zh-CN'
  const otherLabel = lang === 'zh-CN' ? 'EN' : '中文'

  return (
    <header className="nav">
      <div className="container nav-row">
        <a className="brand" href="#top">
          <span className="brand-mark" aria-hidden="true" />
          WorkStep
        </a>
        <nav className="nav-links" aria-label="main">
          <a href="#features">{t('nav.features')}</a>
          <a href="#remote">{t('nav.remote')}</a>
          <a href="#demos">{t('nav.demos')}</a>
          <a href="#workflow">{t('nav.workflow')}</a>
        </nav>
        <div className="nav-spacer" />
        <button type="button" className="nav-lang" onClick={() => setLang(otherLang)}>
          {otherLabel}
        </button>
        <button type="button" className="nav-cta" onClick={onOpenDownload}>
          <Download size={14} />
          {t('nav.download')}
        </button>
      </div>
    </header>
  )
}
