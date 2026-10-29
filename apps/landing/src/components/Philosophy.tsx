import { ArrowRight, CheckCircle2, Copy, UserRound } from 'lucide-react'
import { useI18n } from '../i18n'

const ROWS = ['1', '2', '3', '4'] as const

export function Philosophy() {
  const { t } = useI18n()

  return (
    <section className="section philosophy" id="philosophy">
      <div className="container philosophy-layout">
        <div className="philosophy-intro">
          <h2 className="section-title">{t('philosophy.title')}</h2>
          <p className="section-lede">{t('philosophy.lede')}</p>
          <div className="philosophy-statement">
            <span className="philosophy-statement-mark" aria-hidden="true">W</span>
            <strong>{t('philosophy.statement')}</strong>
          </div>
        </div>

        <div className="philosophy-compare" aria-label={t('philosophy.compareLabel')}>
          <div className="philosophy-compare-head">
            <div><UserRound size={16} />{t('philosophy.oldTitle')}</div>
            <ArrowRight size={16} aria-hidden="true" />
            <div><CheckCircle2 size={16} />{t('philosophy.newTitle')}</div>
          </div>
          {ROWS.map((row) => (
            <div className="philosophy-row" key={row}>
              <span><Copy size={14} />{t(`philosophy.old${row}`)}</span>
              <ArrowRight className="philosophy-row-arrow" size={14} aria-hidden="true" />
              <strong>{t(`philosophy.new${row}`)}</strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
