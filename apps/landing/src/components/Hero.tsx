import { Download, Play } from 'lucide-react'
import { useI18n } from '../i18n'
import { HeroPreview } from './HeroPreview'

interface HeroProps {
  onOpenDownload: () => void
  onOpenDemos: () => void
}

export function Hero({ onOpenDownload, onOpenDemos }: HeroProps) {
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
            <button type="button" className="btn btn-primary" onClick={onOpenDownload}>
              <Download size={15} />
              {t('hero.ctaPrimary')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onOpenDemos}>
              <Play size={14} />
              {t('hero.ctaSecondary')}
            </button>
          </div>
          <div className="hero-meta">
            <span>{t('hero.meta1')}</span>
            <span>{t('hero.meta2')}</span>
            <span>{t('hero.meta3')}</span>
          </div>
        </div>
        <HeroPreview />
      </div>
    </section>
  )
}
