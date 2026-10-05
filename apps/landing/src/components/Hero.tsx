import { ArrowRight, Play } from 'lucide-react'
import { useI18n } from '../i18n'
import { HeroPreview } from './HeroPreview'

interface HeroProps {
  onOpenDemos: () => void
  experienceHref: string
}

export function Hero({ onOpenDemos, experienceHref }: HeroProps) {
  const { t } = useI18n()

  return (
    <section className="hero" id="top">
      <div className="container hero-grid">
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
          <p className="hero-lede">{t('hero.lede')}</p>
          <div className="hero-actions">
            <a href={experienceHref} className="btn btn-primary">
              {t('hero.ctaStart')}
              <ArrowRight size={15} />
            </a>
            <button type="button" className="btn btn-ghost" onClick={onOpenDemos}>
              <Play size={14} />
              {t('hero.ctaSecondary')}
            </button>
          </div>
          <div className="hero-meta">
            <span>{t('hero.meta1')}</span>
            <span>{t('hero.meta2')}</span>
            <span>{t('hero.meta3')}</span>
            <span>{t('hero.meta4')}</span>
          </div>
        </div>
        <HeroPreview />
      </div>
    </section>
  )
}
