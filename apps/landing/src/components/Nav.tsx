import { Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { useI18n, type Lang } from '../i18n'
import { applyTheme, initialTheme, nextTheme } from '../theme'
import { RELEASES_URL } from '../config/downloads'

export function Nav() {
  const { t, lang, setLang } = useI18n()
  const [theme, setTheme] = useState(initialTheme)
  const otherLang: Lang = lang === 'zh-CN' ? 'en-US' : 'zh-CN'
  const otherLabel = lang === 'zh-CN' ? 'EN' : '中文'
  const themeLabel = theme === 'light' ? t('nav.themeDark') : t('nav.themeLight')

  const handleThemeToggle = () => {
    const next = nextTheme(theme)
    applyTheme(next)
    setTheme(next)
  }

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
        <div className="nav-actions">
          <a href={RELEASES_URL} className="nav-control nav-download">
            {t('common.download')}
          </a>
          <button type="button" className="nav-control nav-lang" onClick={() => setLang(otherLang)}>
            {otherLabel}
          </button>
          <button
            type="button"
            className="nav-control nav-theme"
            aria-label={themeLabel}
            aria-pressed={theme === 'dark'}
            title={themeLabel}
            onClick={handleThemeToggle}
          >
            {theme === 'light' ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </header>
  )
}
