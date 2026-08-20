import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Button from '../components/Button'
import FlowCanvas, { type FlowCanvasHandle } from '../components/FlowCanvas'
import AiFlowEditorPanel from '../components/AiFlowEditorPanel'
import ConfirmDialog from '../components/ConfirmDialog'
import Select from '../components/Select'
import { useProjectStore } from '../stores/projectStore'
import { useI18n } from '../i18n'

/* ══════════════════════════════════════════
   Workflow editor page — project/workflow shell
   around the reusable FlowCanvas component.
   ══════════════════════════════════════════ */

function CanvasEditorInner() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const activeProject = useProjectStore((s) => s.activeProject)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const saveSteps = useProjectStore((s) => s.saveSteps)
  const fetchProjects = useProjectStore((s) => s.fetchProjects)
  const activeWorkflowId = useProjectStore(s => s.activeWorkflowId)
  const setActiveWorkflow = useProjectStore(s => s.setActiveWorkflow)
  const dirty = useProjectStore(s => s.canvasDirty)
  const setCanvasDirty = useProjectStore(s => s.setCanvasDirty)
  const wfParam = searchParams.get('workflow')
  const projectParam = searchParams.get('project')
  const activeWorkflow = activeProject?.workflows?.find((workflow) => workflow.id === activeWorkflowId)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [pendingWfId, setPendingWfId] = useState<string | null>(null)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [pendingAiSteps, setPendingAiSteps] = useState<any>(null)
  const [aiGenBusy, setAiGenBusy] = useState(false)
  const [aiConfirmClose, setAiConfirmClose] = useState(false)
  const canvasRef = useRef<FlowCanvasHandle>(null)

  useEffect(() => {
    if (!projectParam) return

    const doLoad = async () => {
      await fetchProjects()
      const currentProjects = useProjectStore.getState().projects
      const match = currentProjects.find((p) => p.name === projectParam)
      if (match) {
        setActiveProject(match)
        const targetWf = wfParam
          ? match.workflows?.find(w => w.id === wfParam)
          : match.workflows?.find(w => w.is_default) || match.workflows?.[0]
        if (targetWf) setActiveWorkflow(targetWf.id)
      }
    }
    doLoad()
  }, [projectParam, wfParam]) // eslint-disable-line

  const switchWorkflow = (id: string) => {
    setActiveWorkflow(id || null)
    setCanvasDirty(false)
    navigate(`/canvas?project=${encodeURIComponent(activeProject?.name || '')}&workflow=${encodeURIComponent(id)}`, { replace: true })
  }

  const requestCloseAiPanel = () => {
    if (aiGenBusy) { setAiConfirmClose(true); return }
    setAiPanelOpen(false)
  }

  const toggleAiPanel = () => {
    if (!activeProject?.id) return
    if (aiPanelOpen) {
      requestCloseAiPanel()
      return
    }
    setAiPanelOpen(true)
    setAiConfirmClose(false)
  }

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', alignItems: 'stretch' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <FlowCanvas
        initialSteps={activeProject?.steps}
        projectId={activeProject?.id}
        onDirtyChange={setCanvasDirty}
        onSave={async (steps) => {
          if (!activeProject) return
          await saveSteps(activeProject.id, steps)
          setActiveProject({ ...activeProject, steps })
        }}
        toolbarLeft={
          <Button
            variant="ghost"
            aria-label={t('canvas.backBoardAria')}
            title={t('canvas.backBoardTitle')}
            onClick={() => {
              if (dirty) { setConfirmLeave(true); return }
              setCanvasDirty(false)
              navigate('/tasks')
            }}
            style={{ height: 30, padding: '0 9px' }}
          >
            {t('canvas.board')}
          </Button>
        }
        toolbarMid={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {(activeProject?.workflows || []).length > 1 && (
              <Select
                value={activeWorkflowId || ''}
                onChange={(e) => {
                  const id = e.target.value
                  if (dirty) { setPendingWfId(id); return }
                  switchWorkflow(id)
                }}
                style={{ height: 28, maxWidth: 160 }}
              >
                {(activeProject?.workflows || []).map(wf => (
                  <option key={wf.id} value={wf.id}>{wf.name}{wf.is_default ? t('canvas.defaultSuffix') : ''}</option>
                ))}
              </Select>
            )}
            <Button
              variant="ghost"
              title={activeProject?.id ? t('canvas.aiEditTitle') : t('canvas.aiEditNoProject')}
              disabled={!activeProject?.id}
              aria-expanded={aiPanelOpen}
              onClick={toggleAiPanel}
              style={{ height: 28, fontSize: 13, whiteSpace: 'nowrap' }}
            >
              {t('canvas.aiEdit')}
            </Button>
          </div>
        }
        ref={canvasRef}
      />

      </div>

      {/* AI flow-design right side panel (inline, pushes the canvas — not a floating overlay) */}
      {aiPanelOpen && (
        <AiFlowEditorPanel
          projectId={activeProject?.id || ''}
          workflowId={activeWorkflowId || undefined}
          workflowName={activeWorkflow?.name || ''}
          getCanvasSteps={() => canvasRef.current?.getSteps()}
          onProposal={(steps) => {
            if (dirty) { setPendingAiSteps(steps); return }
            canvasRef.current?.loadSteps(steps)
          }}
          onRestore={(steps) => canvasRef.current?.loadSteps(steps)}
          onBusyChange={setAiGenBusy}
          onRequestClose={requestCloseAiPanel}
          title={t('canvas.aiEditFlowTitle')}
        />
      )}

      {/* AI panel: close while generating */}
      <ConfirmDialog
        open={aiConfirmClose}
        title={t('canvas.aiGeneratingTitle')}
        message={t('canvas.aiGeneratingMessage')}
        confirmText={t('common.close')}
        onConfirm={() => { setAiConfirmClose(false); setAiPanelOpen(false) }}
        onCancel={() => setAiConfirmClose(false)}
      />

      {/* AI proposal overwrites manual canvas edits */}
      <ConfirmDialog
        open={pendingAiSteps !== null}
        title={t('canvas.proposalOverwriteTitle')}
        message={t('canvas.proposalOverwriteMessage')}
        confirmText={t('canvas.applyProposal')}
        danger
        onConfirm={() => {
          if (pendingAiSteps !== null) canvasRef.current?.loadSteps(pendingAiSteps)
          setPendingAiSteps(null)
        }}
        onCancel={() => setPendingAiSteps(null)}
      />

      {/* Unsaved changes confirm dialogs */}
      <ConfirmDialog
        open={confirmLeave}
        title={t('canvas.unsavedTitle')}
        message={t('canvas.unsavedLeaveMessage')}
        confirmText={t('canvas.leave')}
        onConfirm={() => { setConfirmLeave(false); setCanvasDirty(false); navigate('/tasks') }}
        onCancel={() => setConfirmLeave(false)}
      />
      <ConfirmDialog
        open={pendingWfId !== null}
        title={t('canvas.unsavedTitle')}
        message={t('canvas.unsavedSwitchMessage')}
        confirmText={t('canvas.switch')}
        onConfirm={() => { if (pendingWfId !== null) switchWorkflow(pendingWfId); setPendingWfId(null) }}
        onCancel={() => setPendingWfId(null)}
      />
    </div>
  )
}

export default function CanvasEditor() {
  return <CanvasEditorInner />
}
