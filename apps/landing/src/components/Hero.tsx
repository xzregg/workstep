import { ArrowRight, Play } from 'lucide-react'
import { useI18n } from '../i18n'
import { GuidedWalkthrough } from './GuidedWalkthrough'

interface HeroProps {
  onOpenDemos: () => void
  experienceHref: string
}

export function Hero({ onOpenDemos, experienceHref }: HeroProps) {
  const { t } = useI18n()

  return (
    <section className="hero hero-recorded" id="top">
      <div className="container hero-grid">
        <div className="hero-header">
          <div className="hero-copy">
            <div className="hero-eyebrow">
              <span className="eyebrow-dot" />
              {t('hero.eyebrow')}
            </div>
            <h1>
              {t('hero.titleA')}
              <br />
              <em>{t('hero.titleB')}</em>
            </h1>
          </div>
          <div className="hero-support">
            <p className="hero-promise">{t('hero.promise')}</p>
            <p className="hero-lede">{t('hero.lede')}</p>
            <div className="hero-actions">
              <a href={experienceHref} className="btn btn-primary">
                {t(experienceHref === '/' ? 'common.openWorkspace' : 'hero.ctaPrimary')}
                <ArrowRight size={15} />
              </a>
              <button type="button" className="btn btn-ghost" onClick={onOpenDemos}>
                <Play size={14} />
                {t('hero.ctaSecondary')}
              </button>
            </div>
            <p className="hero-setup">
              {t('hero.setup')} <a href="#docs/getting-started">{t('hero.setupGuide')}</a>
            </p>
          </div>
        </div>
        <GuidedWalkthrough />
        <div className="hero-meta">
          <span>{t('hero.meta1')}</span>
          <span>{t('hero.meta2')}</span>
          <span>{t('hero.meta3')}</span>
          <span>{t('hero.meta4')}</span>
        </div>
      </div>
    </section>
  )
}
