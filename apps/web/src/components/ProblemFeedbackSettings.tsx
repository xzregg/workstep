import { useI18n } from '../i18n'

export default function ProblemFeedbackSettings() {
  const { t } = useI18n()
  return (
    <div className="settings-system-page">
      <h1 className="settings-system-title">{t('settings.problemFeedback')}</h1>
      <p className="settings-system-description">{t('settings.problemFeedbackIntro')}</p>
      <a className="btn btn-ghost"
        href="https://github.com/xzregg/workstep/issues/new?template=bug_report.yml"
        target="_blank" rel="noopener noreferrer">
        {t('settings.problemFeedback')}
      </a>
    </div>
  )
}
