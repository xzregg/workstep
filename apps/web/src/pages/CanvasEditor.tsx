import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Button from '../components/Button'
import FlowCanvas, { type FlowCanvasHandle } from '../components/FlowCanvas'
import AiFlowChat from '../components/AiFlowChat'
import ConfirmDialog from '../components/ConfirmDialog'
import Select from '../components/Select'
import { useProjectStore } from '../stores/projectStore'

/* ══════════════════════════════════════════
   Workflow editor page — project/workflow shell
   around the reusable FlowCanvas component.
   ══════════════════════════════════════════ */

function CanvasEditorInner() {
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
            aria-label="返回任务看板"
            title="返回当前项目的任务看板"
            onClick={() => {
              if (dirty) { setConfirmLeave(true); return }
              setCanvasDirty(false)
              navigate('/tasks')
            }}
            style={{ height: 30, padding: '0 9px' }}
          >
            ← 看板
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
                  <option key={wf.id} value={wf.id}>{wf.name}{wf.is_default ? ' (默认)' : ''}</option>
                ))}
              </Select>
            )}
            <Button
              variant="ghost"
              title="让 AI 根据目标生成或调整当前流程"
              onClick={() => { setAiPanelOpen(true); setAiConfirmClose(false) }}
              style={{ height: 28, fontSize: 13, whiteSpace: 'nowrap' }}
            >
              AI 编辑
            </Button>
          </div>
        }
        ref={canvasRef}
      />

      </div>

      {/* AI flow-design right side panel (inline, pushes the canvas — not a floating overlay) */}
      {aiPanelOpen && (
        <div style={{
          width: 400, maxWidth: '90vw', flexShrink: 0,
          background: 'var(--surface)', borderLeft: '1px solid var(--border-soft)',
          display: 'flex', flexDirection: 'column', minHeight: 0,
        }}>
          <AiFlowChat
            projectId={activeProject?.id || ''}
            onProposal={(steps) => {
              // Applying a proposal replaces the canvas; guard manual edits.
              if (dirty) { setPendingAiSteps(steps); return }
              canvasRef.current?.loadSteps(steps)
            }}
            onBusyChange={setAiGenBusy}
            onClose={() => { if (aiGenBusy) { setAiConfirmClose(true); return } setAiPanelOpen(false) }}
            title="AI 编辑流程"
          />
        </div>
      )}

      {/* AI panel: close while generating */}
      <ConfirmDialog
        open={aiConfirmClose}
        title="AI 正在生成"
        message="AI 仍在生成中，关闭面板后生成结果仍会应用到画布。确定关闭？"
        confirmText="关闭"
        onConfirm={() => { setAiConfirmClose(false); setAiPanelOpen(false) }}
        onCancel={() => setAiConfirmClose(false)}
      />

      {/* AI proposal overwrites manual canvas edits */}
      <ConfirmDialog
        open={pendingAiSteps !== null}
        title="AI 提案将覆盖画布"
        message="应用 AI 提案将替换当前画布上的手动改动（未保存的更改会丢失）。确定应用？"
        confirmText="应用提案"
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
        title="未保存的更改"
        message="有未保存的更改，确定离开？"
        confirmText="离开"
        onConfirm={() => { setConfirmLeave(false); setCanvasDirty(false); navigate('/tasks') }}
        onCancel={() => setConfirmLeave(false)}
      />
      <ConfirmDialog
        open={pendingWfId !== null}
        title="未保存的更改"
        message="有未保存的更改，确定切换工作流？"
        confirmText="切换"
        onConfirm={() => { if (pendingWfId !== null) switchWorkflow(pendingWfId); setPendingWfId(null) }}
        onCancel={() => setPendingWfId(null)}
      />
    </div>
  )
}

export default function CanvasEditor() {
  return <CanvasEditorInner />
}
