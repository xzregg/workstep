import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import type { GenProposalCard } from '../stores/workflowGenStore'
import { assistantStarterPrompt, backfillEmptyTitle } from '../utils/assistantTitle'
import { fetchTemplates, templateApi, type TemplateInfo } from '../api/client'
import AiFlowChat from './AiFlowChat'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Field from './Field'
import FlowCanvas, { type FlowCanvasHandle } from './FlowCanvas'
import Icon from './Icon'
import Input from './Input'
import Select from './Select'

interface WorkflowCreateDialogProps {
  projectId: string | null
  onClose: () => void
}

const hasWhitespace = (value: string) => /\s/.test(value)

export default function WorkflowCreateDialog({ projectId, onClose }: WorkflowCreateDialogProps) {
  const { t } = useI18n()
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
  const [pendingAiSteps, setPendingAiSteps] = useState<any>(null)
  const [dialogSize, setDialogSize] = useState<{ width: number; height: number } | null>(null)
  const [chatWidth, setChatWidth] = useState<number | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiMessage, setAiMessage] = useState('')
  const [name, setName] = useState('')
  const canvasRef = useRef<FlowCanvasHandle>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setTemplates([])
    setTemplateId('')
    setSteps(null)
    setPreviewDirty(false)
    setGenerationBusy(false)
    setCreating(false)
    setError('')
    setNameAttempted(false)
    setConfirmClose(false)
    setPendingAiSteps(null)
    setDialogSize(null)
    setChatWidth(null)
    setAiOpen(false)
    setAiMessage('')
    setName('')
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

  if (!projectId) return null

  const close = () => {
    reset()
    onClose()
  }

  const requestClose = () => {
    if (previewDirty || generationBusy) {
      setConfirmClose(true)
      return
    }
    close()
  }

  const handleProposal = (nextSteps: any, proposal?: GenProposalCard) => {
    setName((current) => backfillEmptyTitle(current, proposal?.workflowName))
    if (previewDirty) {
      setPendingAiSteps(nextSteps)
      return
    }
    setSteps(nextSteps)
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
    if (aiOpen) {
      if (generationBusy) setConfirmClose(true)
      else setAiOpen(false)
      return
    }
    setNameAttempted(false)
    setAiMessage(assistantStarterPrompt(
      name,
      (workflowName) => t('layout.aiCreatePrompt', { name: workflowName }),
    ))
    setAiOpen(true)
  }

  const handleCreate = async () => {
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

  const startDialogResize = (event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const rect = dialogRef.current?.getBoundingClientRect()
    const startWidth = rect?.width ?? window.innerWidth * 0.9
    const startHeight = rect?.height ?? 780
    const onMove = (moveEvent: MouseEvent) => {
      setDialogSize({
        width: Math.min(window.innerWidth - 24, Math.max(760, startWidth + moveEvent.clientX - startX)),
        height: Math.min(window.innerHeight - 24, Math.max(480, startHeight + moveEvent.clientY - startY)),
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'nwse-resize'
  }

  return (
    <>
      <div className="modal-overlay" style={{ zIndex: 350 }}>
        <div
          ref={dialogRef}
          className="modal"
          style={{
            width: dialogSize ? dialogSize.width : '90vw', maxWidth: '96vw',
            height: dialogSize ? dialogSize.height : 'min(92vh, 900px)', maxHeight: '92vh',
            display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden',
            position: 'relative',
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="modal-header">
            <span className="modal-title">{t('layout.addFlowTitle')}</span>
            <Button variant="icon" aria-label={t('common.close')} onClick={requestClose}>✕</Button>
          </div>
          <div style={{
            flexShrink: 0, padding: '12px 18px', background: 'var(--bg)',
            borderBottom: '1px solid var(--border-soft)',
            display: 'flex', gap: 14, alignItems: 'flex-start',
          }}>
            <div style={{ flex: 1, minWidth: 200 }}>
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
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Input
                    id="wf-name"
                    ref={nameInputRef}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('layout.flowNamePlaceholder')}
                    autoFocus
                    style={{
                      flex: 1, minWidth: 0,
                      border: `1px solid ${(hasWhitespace(name) || (nameAttempted && !name.trim())) ? 'var(--danger)' : 'var(--border)'}`,
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleAi}
                    aria-expanded={aiOpen}
                    title={t('layout.aiCreateTitle')}
                    style={{
                      flexShrink: 0, whiteSpace: 'nowrap',
                      color: 'var(--accent)',
                      border: '1px solid color-mix(in oklab, var(--accent), transparent 55%)',
                      background: 'color-mix(in oklab, var(--accent), transparent 93%)',
                    }}
                  >
                    <Icon name="sparkles" size={13} style={{ marginRight: 4, verticalAlign: -2 }} />
                    {t('layout.aiCreate')}
                  </Button>
                </div>
              </Field>
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <Field label={t('layout.flowTemplate')} htmlFor="wf-template">
                <Select
                  id="wf-template"
                  value={templateId}
                  onChange={(event) => void handleTemplateChange(event.target.value)}
                  style={{ width: '100%' }}
                >
                  <option value="">{t('layout.blankFlow')}</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}（{t('flow.nodeCount', { count: template.nodeCount })}）
                    </option>
                  ))}
                </Select>
              </Field>
              {(() => {
                const selected = templates.find((template) => template.id === templateId)
                return selected?.description ? (
                  <p style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selected.description}
                  </p>
                ) : null
              })()}
            </div>
          </div>
          {error && (
            <div style={{
              flexShrink: 0, padding: '5px 18px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)',
              background: 'color-mix(in oklab, var(--danger), transparent 94%)',
              borderBottom: '1px solid var(--border-soft)',
            }}>
              {error}
            </div>
          )}
          <div className="modal-body" style={{ padding: 0, display: 'flex', minHeight: 0, flex: 1, overflow: 'hidden' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
            {aiOpen && (
              <>
                <div
                  onMouseDown={startDividerDrag}
                  title={t('layout.dragResizeChat')}
                  style={{
                    width: 3, flexShrink: 0, cursor: 'col-resize', position: 'relative',
                    background: 'transparent',                  }}
                >
                  <div style={{
                    position: 'absolute', top: 0, bottom: 0, left: '50%', transform: 'translateX(-50%)',
                    width: 1, background: 'var(--border-soft)',
                  }} />
                </div>
                <div style={{
                  width: chatWidth ?? '40%', flexShrink: 0,
                  display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)',
                }}>
                  <AiFlowChat
                    projectId={projectId}
                    getCanvasSteps={() => canvasRef.current?.getSteps()}
                    onProposal={handleProposal}
                    onRestore={(nextSteps) => canvasRef.current?.loadSteps(nextSteps)}
                    onBusyChange={setGenerationBusy}
                    title={t('aiFlow.title')}
                    initialMessage={aiMessage}
                  />
                </div>
              </>
            )}
          </div>
          <div className="modal-footer">
            <Button variant="ghost" onClick={requestClose}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={generationBusy || creating || !name.trim()}
              loading={creating}
              onClick={handleCreate}
            >
              {t('layout.createFlow')}
            </Button>
          </div>
          <div
            onMouseDown={startDialogResize}
            title={t('layout.dragResizeModal')}
            style={{
              position: 'absolute', right: 0, bottom: 0, width: 20, height: 20,
              cursor: 'nwse-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
              padding: 3, color: 'var(--meta)', zIndex: 5,
            }}
          >
            <Icon name="resize-corner" size={11} />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClose}
        title={t('canvas.unsavedTitle')}
        message={generationBusy ? t('layout.abandonGenerating') : t('layout.abandonPreview')}
        confirmText={t('layout.discardChanges')}
        danger
        onConfirm={close}
        onCancel={() => setConfirmClose(false)}
      />

      <ConfirmDialog
        open={pendingAiSteps !== null}
        title={t('layout.aiOverwritePreviewTitle')}
        message={t('layout.aiOverwritePreviewMessage')}
        confirmText={t('canvas.applyProposal')}
        danger
        onConfirm={() => {
          if (pendingAiSteps !== null) setSteps(pendingAiSteps)
          setPendingAiSteps(null)
        }}
        onCancel={() => setPendingAiSteps(null)}
      />
    </>
  )
}
