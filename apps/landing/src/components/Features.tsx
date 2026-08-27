import { CircleCheckBig, GitBranch, History, PackageOpen, RefreshCw, Waypoints } from 'lucide-react'
import { useI18n } from '../i18n'

const ICONS = [History, Waypoints, CircleCheckBig, RefreshCw, GitBranch, PackageOpen]

export function Features() {
  const { t } = useI18n()

  return (
    <section className="section" id="features">
      <div className="container">
        <div className="section-eyebrow">{t('features.eyebrow')}</div>
        <h2 className="section-title">{t('features.title')}</h2>
        <p className="section-lede">{t('features.lede')}</p>
        <div className="features-grid">
          {ICONS.map((Icon, index) => (
            <div key={index} className="feature-card">
              <span className="feature-icon">
                <Icon size={18} />
              </span>
              <h3>{t(`features.item${index + 1}Title`)}</h3>
              <p>{t(`features.item${index + 1}Desc`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
