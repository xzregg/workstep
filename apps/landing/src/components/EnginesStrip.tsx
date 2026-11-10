import { useI18n } from '../i18n'

const ENGINES = [
  { key: 'codex', className: 'dot-codex' },
  { key: 'claude', className: 'dot-claude' },
  { key: 'deepseek_hermes', className: 'dot-hermes' },
  { key: 'qoder', className: 'dot-qoder' },
  { key: 'pydantic', className: 'dot-pydantic' },
] as const

export function EnginesStrip() {
  const { t } = useI18n()

  return (
    <section className="engines-strip" id="engines">
      <div className="container">
        <h2 className="section-title">{t('engines.extension')}</h2>
        <p className="section-lede">{t('engines.description')}</p>
        <div className="engines-row">
          {ENGINES.map(({ key, className }) => (
            <span key={key} className="engine-pill">
              <span className={`engine-dot ${className}`} />
              {t(`engines.${key}`)}
            </span>
          ))}
        </div>
        <a className="engine-guide" href="#docs/custom-engines">{t('engines.guide')} →</a>
      </div>
    </section>
  )
}
