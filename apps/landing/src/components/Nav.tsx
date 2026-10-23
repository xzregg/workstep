import { Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { useI18n, type Lang } from '../i18n'
import { applyTheme, initialTheme, nextTheme } from '../theme'
import { RELEASES_URL } from '../config/downloads'

export function Nav() {
  const { t, lang, setLang } = useI18n()
  const [theme, setTheme] = useState(initialTheme)
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
          <a href="#docs" className="nav-control nav-docs">{t('common.docs')}</a>
          <a href={RELEASES_URL} className="nav-control nav-download">
            {t('common.download')}
          </a>
          <select className="nav-control nav-lang" aria-label={t('nav.language')} value={lang} onChange={event => setLang(event.target.value as Lang)}>
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
            <option value="fr-FR">Français</option>
            <option value="de-DE">Deutsch</option>
            <option value="ar">العربية</option>
          </select>
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
