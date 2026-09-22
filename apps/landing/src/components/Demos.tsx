import { MousePointerClick } from 'lucide-react'
import type { DemoDef } from '../demo/demos'
import { DEMOS } from '../demo/demos'
import { useI18n } from '../i18n'
import { DemoPlayer } from './DemoPlayer'

interface DemosProps {
  onOpen: (demo: DemoDef) => void
}

export function Demos({ onOpen }: DemosProps) {
  const { t } = useI18n()

  return (
    <section className="section section-alt" id="demos">
      <div className="container">
        <div className="section-eyebrow">{t('demos.eyebrow')}</div>
        <h2 className="section-title">{t('demos.title')}</h2>
        <p className="section-lede">{t('demos.lede')}</p>
        <div className="demos-grid">
          {DEMOS.map((demo, index) => (
            <div
              key={demo.id}
              className="demo-card"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(demo)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpen(demo)
                }
              }}
              aria-label={t(`demos.item${index + 1}Title`)}
            >
              <DemoPlayer demo={demo} autoplay showControls={false} />
              <div className="demo-card-copy">
                <h3>{t(`demos.item${index + 1}Title`)}</h3>
                <p>{t(`demos.item${index + 1}Desc`)}</p>
              </div>
              <span className="demo-open-hint">
                <MousePointerClick size={13} />
                {t('demos.hint')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
