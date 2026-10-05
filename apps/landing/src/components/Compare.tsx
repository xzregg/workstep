import { useI18n } from '../i18n'

const ROWS = ['1', '2', '3', '4', '5', '6', '7'] as const

export function Compare() {
  const { t } = useI18n()

  return (
    <section className="section section-alt" id="compare">
      <div className="container">
        <div className="section-eyebrow">{t('compare.eyebrow')}</div>
        <h2 className="section-title">{t('compare.title')}</h2>
        <p className="section-lede">{t('compare.lede')}</p>
        <div className="compare-table">
          <div className="compare-row compare-head">
            <div className="compare-cell compare-corner" />
            <div className="compare-cell compare-col-workstep">{t('compare.colWorkStep')}</div>
            <div className="compare-cell">{t('compare.colApi')}</div>
            <div className="compare-cell">{t('compare.colCode')}</div>
            <div className="compare-cell">{t('compare.colHosted')}</div>
          </div>
          {ROWS.map((row) => (
            <div className="compare-row" key={row}>
              <div className="compare-cell compare-label">{t(`compare.row${row}Label`)}</div>
              <div className="compare-cell compare-col-workstep">{t(`compare.row${row}WorkStep`)}</div>
              <div className="compare-cell">{t(`compare.row${row}Api`)}</div>
              <div className="compare-cell">{t(`compare.row${row}Code`)}</div>
              <div className="compare-cell">{t(`compare.row${row}Hosted`)}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
