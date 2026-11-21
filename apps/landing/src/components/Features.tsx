import { PackageOpen, RefreshCw, Waypoints } from 'lucide-react'
import { useI18n } from '../i18n'

const FEATURES = [
  { Icon: Waypoints, index: 1 },
  { Icon: PackageOpen, index: 3 },
  { Icon: RefreshCw, index: 4 },
]

export function Features() {
  const { t } = useI18n()

  return (
    <section className="section" id="features">
      <div className="container">
        <div className="section-eyebrow">{t('features.eyebrow')}</div>
        <h2 className="section-title">{t('features.title')}</h2>
        <p className="section-lede">{t('features.lede')}</p>
        <div className="features-grid">
          {FEATURES.map(({ Icon, index }) => (
            <div key={index} className="feature-card">
              <span className="feature-icon">
                <Icon size={18} />
              </span>
              <h3>{t(`features.item${index}Title`)}</h3>
              <p>{t(`features.item${index}Desc`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
