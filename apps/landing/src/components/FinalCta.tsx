import { ArrowRight } from 'lucide-react'
import { useI18n } from '../i18n'

export function FinalCta({ experienceHref }: { experienceHref: string }) {
  const { t } = useI18n()

  return (
    <footer className="final-cta" id="download">
      <div className="final-cta-inner">
        <div>
          <h3>{t('finalCta.title')}</h3>
          <p>{t('finalCta.lede')}</p>
        </div>
        <div className="final-cta-actions">
          <a href={experienceHref} className="btn btn-primary">
            {t(experienceHref === '/' ? 'common.openWorkspace' : 'finalCta.primary')}
            <ArrowRight size={15} />
          </a>
        </div>
      </div>
    </footer>
  )
}
