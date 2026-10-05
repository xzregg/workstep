import { ArrowRight, Play } from 'lucide-react'
import { useI18n } from '../i18n'

export function FinalCta({ experienceHref }: { experienceHref: string }) {
  const { t } = useI18n()

  return (
    <section className="final-cta">
      <div className="container final-cta-inner">
        <div>
          <h2>{t('finalCta.title')}</h2>
          <p>{t('finalCta.lede')}</p>
        </div>
        <div className="final-cta-actions">
          <a href={experienceHref} className="btn btn-primary">
            {t('finalCta.primary')}
            <ArrowRight size={15} />
          </a>
          <a href="#demos" className="btn btn-ghost">
            <Play size={14} />
            {t('finalCta.secondary')}
          </a>
        </div>
      </div>
    </section>
  )
}
