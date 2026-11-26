import './WorkflowCreateDialog.css'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import { useFlowProposalConfirmation } from '../hooks/useFlowProposalConfirmation'
import { visibleTemplates } from '../utils/contentLocale'
import ResizablePanel from './ResizablePanel'
import { useEffect, useRef, useState } from 'react'
import { useI18n, localizeErrorDisplay } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import type { GenProposalCard } from '../stores/workflowGenStore'
import { assistantStarterPrompt, backfillEmptyTitle } from '../utils/assistantTitle'
import { fetchTemplates, templateApi, type TemplateInfo } from '../api/client'
import AiFlowChat, { type AiFlowChatHandle } from './AiFlowChat'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Field from './Field'
import FlowCanvas, { type FlowCanvasHandle } from './FlowCanvas'
import WorkflowExecutionWarningDialog from './WorkflowExecutionWarningDialog'
import type { WorkflowExecutionWarning } from '../utils/workflowExecutionWarnings'
import Icon from './Icon'
import Input from './Input'
import Select from './Select'

interface WorkflowCreateDialogProps {
  projectId: string | null
  onClose: () => void
}

const hasWhitespace = (value: string) => /\s/.test(value)

export default function WorkflowCreateDialog({ projectId, onClose }: WorkflowCreateDialogProps) {
  const { t, locale } = useI18n()
  const compact = useCompactLayout()
  const [activeTab, setActiveTab] = useState<'preview' | 'assistant'>('preview')
  const [closing, setClosing] = useState(false)
  const assistantRef = useRef<AiFlowChatHandle>(null)
  const createWorkflow = useProjectStore((state) => state.createWorkflow)
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [templateId, setTemplateId] = useState('')
  const [steps, setSteps] = useState<any>(null)
  const [previewDirty, setPreviewDirty] = useState(false)
  const [generationBusy, setGenerationBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [nameAttempted, setNameAttempted] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const proposalConfirmation = useFlowProposalConfirmation(projectId || '')
  const [chatWidth, setChatWidth] = useState<number | null>(null)
  const [aiOpen, setAiOpen] = useState(true)
  const [aiMessage, setAiMessage] = useState('')
  const [name, setName] = useState('')
  const [executionWarnings, setExecutionWarnings] = useState<WorkflowExecutionWarning[]>([])
  const canvasRef = useRef<FlowCanvasHandle>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setActiveTab('preview')
    setTemplates([])
    setTemplateId('')
    setSteps(null)
    setPreviewDirty(false)
    setGenerationBusy(false)
    setCreating(false)
    setError('')
    setNameAttempted(false)
    setConfirmClose(false)
    proposalConfirmation.cancel()
    setChatWidth(null)
    setAiOpen(true)
    setAiMessage('')
    setName('')
    setExecutionWarnings([])
  }

  useEffect(() => {
    if (!projectId) return
    let active = true
    reset()
    void fetchTemplates()
      .then(({ templates: list }) => {
        if (active) setTemplates(list)
      })
      .catch(() => {
        if (active) setTemplates([])
      })
    return () => { active = false }
  }, [projectId])

  const close = () => {
    reset()
    onClose()
  }

  const requestClose = () => {
    if (closing || creating) return
    if (previewDirty || generationBusy || name || templateId || assistantRef.current?.hasContent()) {
      setConfirmClose(true)
      return
    }
    close()
  }

  useOverlay(Boolean(projectId), requestClose, dialogRef, compact)

  const discardAndClose = async () => {
    if (closing) return
    setClosing(true)
    try {
      await assistantRef.current?.discard()
      close()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('aiFlow.stopFailed'))
      setConfirmClose(false)
    } finally { setClosing(false) }
  }

  if (!projectId) return null

  const handleProposal = (nextSteps: any, proposal?: GenProposalCard) => {
    const apply = () => {
      setName((current) => backfillEmptyTitle(current, proposal?.workflowName))
      canvasRef.current?.loadSteps(nextSteps)
      setActiveTab('preview')
    }
    if (previewDirty) return proposalConfirmation.request(nextSteps, apply)
    apply()
  }

  const handleTemplateChange = async (nextTemplateId: string) => {
    setTemplateId(nextTemplateId)
    setError('')
    if (!nextTemplateId) {
      setSteps(null)
      return
    }
    try {
      const template = await templateApi.get(nextTemplateId)
      setSteps(template.steps || { nodes: [], connections: [] })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('layout.loadTemplateFailed'))
    }
  }

  const toggleAi = () => {
    if (compact) {
      setActiveTab('assistant')
      setAiOpen(true)
      return
    }
    if (aiOpen) {
      setAiOpen(false)
      return
    }
    setNameAttempted(false)
    setAiMessage(assistantStarterPrompt(
      name,
      (workflowName) => t('layout.aiCreatePrompt', { name: workflowName }),
    ))
    setAiOpen(true)
  }

  const handleCreate = async (confirmedWarnings = false) => {
    if (generationBusy) return
    if (!name.trim() || hasWhitespace(name)) {
      setNameAttempted(true)
      nameInputRef.current?.focus()
      return
    }
    const validationError = canvasRef.current?.validate() ?? null
    if (validationError) {
      setError(validationError)
      return
    }
    const currentSteps = canvasRef.current?.getSteps() ?? steps ?? undefined
    const warnings = canvasRef.current?.getExecutionWarnings() ?? []
    if (warnings.length && !confirmedWarnings) {
      setExecutionWarnings(warnings)
      return
    }
    setCreating(true)
    setError('')
    try {
      await createWorkflow(projectId, name.trim(), templateId || undefined, currentSteps)
      close()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('layout.createWorkflowFailed'))
    } finally {
      setCreating(false)
    }
  }

  const startDividerDrag = (event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const dialogWidth = dialogRef.current?.clientWidth ?? window.innerWidth * 0.9
    const startWidth = chatWidth ?? Math.round((dialogWidth * 2) / 5)
    const onMove = (moveEvent: MouseEvent) => {
      setChatWidth(Math.min(
        Math.round(dialogWidth * 0.6),
        Math.max(280, startWidth - (moveEvent.clientX - startX)),
      ))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }


  return (
    <>
      <div className="modal-overlay workflow-create-overlay">
        <ResizablePanel
          ref={dialogRef}
          className="modal workflow-create-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('layout.addFlowTitle')}
          tabIndex={-1}
          minWidth={760}
          minHeight={480}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="modal-header">
            <span className="modal-title">{t('layout.addFlowTitle')}</span>
            <Button variant="icon" disabled={closing || creating} aria-label={t('common.close')} onClick={requestClose}>✕</Button>
          </div>
          <div className="workflow-create-fields">
            <div className="workflow-create-field">
              <Field
                label={t('layout.flowName')}
                required
                htmlFor="wf-name"
                error={hasWhitespace(name)
                  ? t('layout.nameWhitespace')
                  : nameAttempted && !name.trim()
                    ? t('layout.flowNameRequired')
                    : undefined}
              >
                <div className="workflow-create-name">
                  <Input
                    id="wf-name"
                    ref={nameInputRef}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('layout.flowNamePlaceholder')}
                    autoFocus={!compact}
                    aria-invalid={hasWhitespace(name) || (nameAttempted && !name.trim())}
                    className="workflow-create-name-input"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleAi}
                    aria-expanded={aiOpen}
                    title={t('layout.aiCreateTitle')}
                    className="workflow-create-assistant-toggle"
                  >
                    <Icon name="sparkles" />
                    {t('layout.aiCreate')}
                  </Button>
                </div>
              </Field>
            </div>
            <div className="workflow-create-field">
              <Field label={t('layout.flowTemplate')} htmlFor="wf-template">
                <Select
                  id="wf-template"
                  value={templateId}
                  onChange={(event) => void handleTemplateChange(event.target.value)}
                >
                  <option value="">{t('layout.blankFlow')}</option>
                  {visibleTemplates(templates, locale, templateId).map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}（{t('flow.nodeCount', { count: template.nodeCount })}）
                    </option>
                  ))}
                </Select>
              </Field>
              {(() => {
                const selected = templates.find((template) => template.id === templateId)
                return selected?.description ? (
                  <p className="workflow-create-template-description">
                    {selected.description}
                  </p>
                ) : null
              })()}
            </div>
          </div>
          {error && (
            <div className="workflow-create-error" role="alert">
              {localizeErrorDisplay(error)}
            </div>
          )}
          {compact && <div className="workflow-create-tabs" role="tablist" aria-label={t('layout.addFlowTitle')}>
            {(['preview', 'assistant'] as const).map((tab) => <Button
              key={tab}
              id={`workflow-create-tab-${tab}`}
              role="tab"
              aria-selected={activeTab === tab}
              tabIndex={activeTab === tab ? 0 : -1}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const nextTab = event.key === 'Home' ? 'preview' : event.key === 'End' ? 'assistant'
                  : tab === 'preview' ? 'assistant' : 'preview'
                setActiveTab(nextTab)
                document.getElementById(`workflow-create-tab-${nextTab}`)?.focus()
              }}
              aria-controls={`workflow-create-${tab}`}
              variant="ghost"
              onClick={() => setActiveTab(tab)}
            >{t(tab === 'preview' ? 'layout.previewTitle' : 'layout.aiCreate')}</Button>)}
          </div>}
          <div className="modal-body workflow-create-body">
            <div className="workflow-create-preview" id="workflow-create-preview"
              role={compact ? 'tabpanel' : undefined}
              aria-labelledby={compact ? 'workflow-create-tab-preview' : undefined}
              hidden={compact && activeTab !== 'preview'}>
              <FlowCanvas
                ref={canvasRef}
                initialSteps={steps}
                projectId={projectId}
                onDirtyChange={setPreviewDirty}
                onSave={async (nextSteps) => { setSteps(nextSteps); setPreviewDirty(false) }}
                showTemplatePicker={false}
                title={t('layout.previewTitle')}
                saveLabel={t('layout.updatePreview')}
                hint={null}
              />
            </div>
            <div
              className="workflow-create-divider"
              hidden={compact || !aiOpen}
              onMouseDown={startDividerDrag}
              title={t('layout.dragResizeChat')}
            />
            <div className="workflow-create-assistant" id="workflow-create-assistant"
              role={compact ? 'tabpanel' : undefined}
              aria-labelledby={compact ? 'workflow-create-tab-assistant' : undefined}
              hidden={compact ? activeTab !== 'assistant' : !aiOpen}
              style={chatWidth === null || compact ? undefined : { width: chatWidth }}>
              <AiFlowChat
                ref={assistantRef}
                key={projectId}
                projectId={projectId}
                getCanvasSteps={() => canvasRef.current?.getSteps()}
                onPreview={(nextSteps) => canvasRef.current?.previewSteps(nextSteps)}
                onProposal={handleProposal}
                onRestore={(nextSteps) => canvasRef.current?.loadSteps(nextSteps)}
                onBusyChange={setGenerationBusy}
                title={t('aiFlow.title')}
                initialMessage={aiMessage}
              />
            </div>
          </div>
          <div className="modal-footer">
            <Button variant="ghost" disabled={closing || creating} onClick={requestClose}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={generationBusy || creating || closing || !name.trim() || hasWhitespace(name)}
              loading={creating}
              onClick={() => void handleCreate()}
            >
              {t('layout.createFlow')}
            </Button>
          </div>
        </ResizablePanel>
      </div>

      <WorkflowExecutionWarningDialog
        warnings={executionWarnings}
        confirmText={t('layout.createFlow')}
        onConfirm={() => { setExecutionWarnings([]); void handleCreate(true) }}
        onCancel={() => setExecutionWarnings([])}
      />

      <ConfirmDialog
        open={confirmClose}
        title={t('canvas.unsavedTitle')}
        message={generationBusy ? t('layout.abandonGenerating') : t('layout.abandonPreview')}
        confirmText={t('layout.discardChanges')}
        danger
        loading={closing}
        onConfirm={() => void discardAndClose()}
        onCancel={() => { if (!closing) setConfirmClose(false) }}
      />

      <ConfirmDialog
        open={proposalConfirmation.steps !== null}
        title={t('layout.aiOverwritePreviewTitle')}
        message={t('layout.aiOverwritePreviewMessage')}
        confirmText={t('canvas.applyProposal')}
        danger
        onConfirm={() => void proposalConfirmation.confirm()}
        onCancel={proposalConfirmation.cancel}
      />
    </>
  )
}
