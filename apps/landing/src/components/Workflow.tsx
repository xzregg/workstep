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


function WorkflowCard({ template }: { template: TemplateDef['key'] }) {
  const { t } = useI18n()
  return <div className="workflow-card">
    <h3 className="workflow-card-title"><span className={`workflow-card-dot wf-${template}`} />{t(`workflow.${template}Title`)}</h3>
    <p className="workflow-card-desc">{t(`workflow.${template}Desc`)}</p>
    <div className="workflow-card-steps">{STEPS.map((step, index) => <span key={step} className="workflow-card-step">{t(`workflow.${template}${step}`)}{index < STEPS.length - 1 && <i />}</span>)}</div>
  </div>
}

export function Workflow() {
  const { t } = useI18n()

  return (
    <section className="section" id="workflow">
      <div className="container">
        <div className="section-eyebrow">{t('workflow.eyebrow')}</div>
        <h2 className="section-title">{t('workflow.title')}</h2>
        <p className="section-lede">{t('workflow.lede')}</p>

        <div className="workflow-templates">
          {TEMPLATES.map(({ key }) => <WorkflowCard key={key} template={key} />)}
        </div>
      </div>
    </section>
  )
}
