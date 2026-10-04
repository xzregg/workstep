import { useState, type CSSProperties } from 'react'
import type { Project } from '../api/client'
import { projectApi } from '../api/client'
import { useI18n } from '../i18n'
import type { StepData } from './TaskDetailView'
import Button from './Button'
import MarkdownEditor from './MarkdownEditor'
import ResizablePanel from './ResizablePanel'
import StepPromptVariablesHint from './StepPromptVariablesHint'

export function replaceProjectStepPrompt(steps: Project['steps'], stepKey: string, prompt: string): Project['steps'] {
  if (steps?.nodes?.length) {
    return {
      ...steps,
      nodes: steps.nodes.map((node: any) =>
        (node.type || node.key) === stepKey ? { ...node, prompt } : node),
    }
  }
  if (steps?.steps?.length) {
    return {
      ...steps,
      steps: steps.steps.map((step: any) =>
        (step.key || step.id) === stepKey ? { ...step, prompt } : step),
    }
  }
  return steps
}

interface Props {
  project: Project | null | undefined
  step: StepData
  projectId: string
  onSaved: (steps: Project['steps']) => void
  onClose: () => void
}

/** Owns the quick edit draft, persistence, error state, and dialog. */
export default function StepPromptEditor({ project, step, projectId, onSaved, onClose }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(step.prompt)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    if (!project || saving) return
    const nextSteps = replaceProjectStepPrompt(project.steps, step.key, draft)
    setSaving(true)
    setError('')
    try {
      await projectApi.saveSteps(project.id, nextSteps)
      onSaved(nextSteps)
      onClose()
    } catch (reason) {
      setError(t('taskDetail.saveFailed', {
        error: reason instanceof Error ? reason.message : t('common.unknownError'),
      }))
    } finally {
      setSaving(false)
    }
  }

  return <div
    role="dialog"
    aria-modal="true"
    aria-label={t('taskDetail.quickEditPromptAria', { step: step.label })}
    className="step-prompt-editor-overlay"
    onClick={() => { if (!saving) onClose() }}
  >
    <ResizablePanel
      className="step-prompt-editor-panel"
      minWidth={520}
      minHeight={320}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="dialog-header">
        <span className="step-prompt-editor-step-dot" style={{ '--step-prompt-color': step.color || 'var(--accent)' } as CSSProperties} />
        <div className="step-prompt-editor-heading">
          <div className="step-prompt-editor-title">{t('taskDetail.quickEditPrompt')}</div>
          <div className="step-prompt-editor-subtitle">{step.label} · {step.key}</div>
        </div>
        <Button variant="icon" disabled={saving} onClick={onClose}>✕</Button>
      </div>
      <div className="step-prompt-editor-body">
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          projectId={projectId}
          placeholder={t('taskDetail.promptEditorPlaceholder')}
          minHeight={260}
          maxHeight="55vh"
          autoFocus
          ariaLabel={t('taskDetail.stepPromptAria', { step: step.label })}
        />
        <StepPromptVariablesHint />
        {error && <div role="alert" className="step-prompt-editor-error">{error}</div>}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={saving} loading={saving} onClick={() => void save()}>
          {t('taskDetail.savePrompt')}
        </Button>
      </div>
    </ResizablePanel>
  </div>
}
