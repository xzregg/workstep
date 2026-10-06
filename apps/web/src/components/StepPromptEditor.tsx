import { useEffect, useState, type CSSProperties } from 'react'
import type { Project } from '../api/client'
import { workflowApi } from '../api/client'
import { useI18n } from '../i18n'
import type { StepData } from './TaskDetailView'
import Button from './Button'
import MarkdownEditor from './MarkdownEditor'
import ResizablePanel from './ResizablePanel'
import StepPromptVariablesHint from './StepPromptVariablesHint'

interface Props {
  project: Project | null | undefined
  step: StepData
  projectId: string
  workflowId: string
  onSaved: (steps: Project['steps']) => void
  onClose: () => void
}

/** Owns the quick edit draft, persistence, error state, and dialog. */
export default function StepPromptEditor({ project, step, projectId, workflowId, onSaved, onClose }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(step.prompt)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    workflowApi.get(workflowId, projectId).then((workflow) => {
      if (cancelled) return
      const nodes = workflow.steps?.nodes
      const items = nodes?.length ? nodes : workflow.steps?.steps || []
      const selected = items.find((item: any) =>
        (nodes?.length ? item.type || item.key || item.id : item.key || item.id || item.type) === step.key)
      if (!selected) throw new Error('Step not found')
      setDraft(selected.prompt || '')
      setLoaded(true)
    }).catch((reason) => {
      if (!cancelled) setError(t('taskDetail.saveFailed', { error: String(reason) }))
    })
    return () => { cancelled = true }
  }, [workflowId, projectId, step.key, t])

  const save = async () => {
    if (!project || saving || !loaded) return
    setSaving(true)
    setError('')
    try {
      const result = await workflowApi.updateStepPrompt(workflowId, projectId, step.key, draft)
      onSaved(result.steps)
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
          disabled={!loaded || saving}
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
        <Button variant="primary" disabled={saving || !loaded} loading={saving} onClick={() => void save()}>
          {t('taskDetail.savePrompt')}
        </Button>
      </div>
    </ResizablePanel>
  </div>
}
