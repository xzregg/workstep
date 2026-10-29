import { ArrowRight, Play } from 'lucide-react'
import { useI18n } from '../i18n'

interface HeroProps { onOpenDemos: () => void; experienceHref: string }
export function Hero({ onOpenDemos, experienceHref }: HeroProps) {
  const { t } = useI18n()
  return <section className="intro" id="top" aria-labelledby="intro-title">
    <div className="container intro-content">
      <div className="intro-heading">
        <p className="intro-kicker">{t('hero.eyebrow')}</p>
        <h1 id="intro-title">{t('hero.titleA')}<br />{t('hero.titleB')}</h1>
      </div>
      <div className="intro-copy">
        <p className="intro-description">{t('hero.lede')}</p>
        <div className="intro-actions"><a href={experienceHref} className="btn btn-primary">{t(experienceHref === '/' ? 'common.openWorkspace' : 'hero.ctaPrimary')}<ArrowRight size={17} /></a><button type="button" className="btn btn-ghost" onClick={onOpenDemos}><Play size={15} />{t('hero.ctaSecondary')}</button></div>
        <p className="intro-setup">{t('hero.setup')} <a href="#start">{t('hero.setupGuide')} ↗</a></p>
      </div>
    </div>
  </section>
}
