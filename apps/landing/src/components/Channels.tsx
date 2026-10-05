import { CircleCheckBig, MessagesSquare, Workflow } from 'lucide-react'
import { useI18n } from '../i18n'

const ICONS = [MessagesSquare, Workflow, CircleCheckBig]

export function Channels() {
  const { t } = useI18n()

  return (
    <section className="section section-alt" id="channels">
      <div className="container">
        <div className="section-eyebrow">{t('channels.eyebrow')}</div>
        <h2 className="section-title">{t('channels.title')}</h2>
        <p className="section-lede">{t('channels.lede')}</p>
        <div className="features-grid">
          {ICONS.map((Icon, index) => (
            <div key={index} className="feature-card">
              <span className="feature-icon"><Icon size={18} aria-hidden="true" /></span>
              <h3>{t(`channels.item${index + 1}Title`)}</h3>
              <p>{t(`channels.item${index + 1}Desc`)}</p>
            </div>
          ))}
        </div>
        <p className="channels-note">{t('channels.note')}</p>
      </div>
    </section>
  )
}
