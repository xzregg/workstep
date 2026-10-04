import type { CSSProperties } from 'react'
import { useI18n } from '../i18n'
import Button from './Button'
import MarkdownMessage from './MarkdownMessage'

interface Props {
  label: string
  color: string
  prompt: string
  projectId?: string
  onEdit?: () => void
}

/** Selected step's prompt preview and its optional quick edit entry. */
export default function TaskStepPrompt({ label, color, prompt, projectId, onEdit }: Props) {
  const { t } = useI18n()
  return <section className="task-step-prompt"
    style={{ '--task-step-prompt-color': color } as CSSProperties}>
    <div className="task-step-prompt-step">{label}</div>
    <div className="task-step-prompt-header">
      <span className="task-step-prompt-heading">{t('taskDetail.stepPrompt')}</span>
      {onEdit && <Button variant="ghost" className="task-step-prompt-edit" onClick={onEdit}>
        <span aria-hidden="true">✎</span>{t('taskDetail.quickEdit')}
      </Button>}
    </div>
    <div className="task-step-prompt-preview">
      {prompt ? <MarkdownMessage content={prompt} projectId={projectId} />
        : <div className="task-step-prompt-empty">{t('taskDetail.noStepPrompt')}</div>}
    </div>
  </section>
}
