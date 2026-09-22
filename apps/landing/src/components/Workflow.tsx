import { useI18n } from '../i18n'

interface TemplateDef {
  key: 'rd' | 'writing' | 'data' | 'ops'
}

const TEMPLATES: TemplateDef[] = [
  { key: 'rd' },
  { key: 'writing' },
  { key: 'data' },
  { key: 'ops' },
]

const STEPS = ['Step1', 'Step2', 'Step3', 'Step4', 'Step5', 'Step6'] as const

export function Workflow() {
  const { t } = useI18n()

  return (
    <section className="section" id="workflow">
      <div className="container">
        <div className="section-eyebrow">{t('workflow.eyebrow')}</div>
        <h2 className="section-title">{t('workflow.title')}</h2>
        <p className="section-lede">{t('workflow.lede')}</p>

        <div className="workflow-templates">
          {TEMPLATES.map(({ key }) => (
            <div key={key} className="workflow-card">
              <div className="workflow-card-title">
                <span className={`workflow-card-dot wf-${key}`} />
                {t(`workflow.${key}Title`)}
              </div>
              <p className="workflow-card-desc">{t(`workflow.${key}Desc`)}</p>
              <div className="workflow-card-steps">
                {STEPS.map((step, index) => (
                  <span key={step} className="workflow-card-step">
                    {t(`workflow.${key}${step}`)}
                    {index < STEPS.length - 1 && <i />}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

      </div>
    </section>
  )
}
