import { useCallback, useEffect, useRef, useState } from 'react'
import Button from './Button'
import ResizablePanel from './ResizablePanel'
import { projectApi, workflowApi, type Project, type WorkflowSummary } from '../api/client'
import { useI18n } from '../i18n'
import { loadCanvasData, type StepNodeData } from './flowCanvasData'
import './FlowNodeCopyDialog.css'

interface Props {
  onClose: () => void
  onCopy: (node: StepNodeData) => void
}

export default function FlowNodeCopyDialog({ onClose, onCopy }: Props) {
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState('')
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeWorkflowKey, setActiveWorkflowKey] = useState<string | null>(null)
  const [nodesByWorkflow, setNodesByWorkflow] = useState<Record<string, StepNodeData[]>>({})
  const [workflowLoading, setWorkflowLoading] = useState<string | null>(null)
  const [workflowErrors, setWorkflowErrors] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<{ data: StepNodeData; sourceKey: string } | null>(null)
  const cache = useRef<Record<string, StepNodeData[]>>({})

  const loadWorkflow = useCallback(async (projectId: string, workflowId: string) => {
    const key = `${projectId}/${workflowId}`
    if (cache.current[key]) {
      setNodesByWorkflow((current) => ({ ...current, [key]: cache.current[key] }))
      setWorkflowErrors((current) => { const next = { ...current }; delete next[key]; return next })
      return
    }
    setWorkflowLoading(key)
    setWorkflowErrors((current) => { const next = { ...current }; delete next[key]; return next })
    try {
      const workflow = await workflowApi.get(workflowId, projectId)
      const nodes = loadCanvasData(workflow.steps).nodes
      cache.current[key] = nodes
      setNodesByWorkflow((current) => ({ ...current, [key]: nodes }))
    } catch (error) {
      setWorkflowErrors((current) => ({
        ...current,
        [key]: t('flow.copyNodeFailed', { error: error instanceof Error ? error.message : t('flow.networkError') }),
      }))
    } finally {
      setWorkflowLoading((current) => current === key ? null : current)
    }
  }, [t])

  const selectProject = useCallback((project: Project) => {
    setActiveProjectId(project.id)
    setSelected(null)
    const workflow = (project.workflows || []).find((item) => !item.deleted)
    setActiveWorkflowKey(workflow ? `${project.id}/${workflow.id}` : null)
    if (workflow) void loadWorkflow(project.id, workflow.id)
  }, [loadWorkflow])

  const selectWorkflow = (project: Project, workflow: WorkflowSummary) => {
    const key = `${project.id}/${workflow.id}`
    setActiveWorkflowKey(key)
    setSelected(null)
    if (!cache.current[key]) void loadWorkflow(project.id, workflow.id)
  }

  useEffect(() => {
    let mounted = true
    projectApi.list().then(({ projects: list }) => {
      if (!mounted) return
      setProjects(list)
      if (list[0]) selectProject(list[0])
    }).catch((error) => {
      if (!mounted) return
      setProjectsError(t('flow.copyNodeFailed', { error: error instanceof Error ? error.message : t('flow.networkError') }))
    }).finally(() => {
      if (mounted) setProjectsLoading(false)
    })
    return () => { mounted = false }
  }, [selectProject, t])

  const activeProject = projects.find((project) => project.id === activeProjectId)
  const workflows = (activeProject?.workflows || []).filter((workflow) => !workflow.deleted)
  const activeWorkflow = workflows.find((workflow) => `${activeProjectId}/${workflow.id}` === activeWorkflowKey)
  const activeNodes = activeWorkflowKey ? nodesByWorkflow[activeWorkflowKey] : undefined

  return (
    <div className="modal-overlay flow-node-copy-overlay" onClick={onClose}>
      <ResizablePanel className="modal flow-node-copy-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{t('flow.copyNodeTitle')}</span>
          <Button variant="icon" aria-label={t('common.cancel')} onClick={onClose}>✕</Button>
        </div>
        <div className="modal-body flow-node-copy-body">
          {projectsLoading ? (
            <div className="flow-node-copy-notice"><span className="task-status-spinner" aria-hidden="true" />{t('flow.copyNodeLoading')}</div>
          ) : projectsError ? (
            <div className="flow-node-copy-notice flow-node-copy-error" role="alert">{projectsError}</div>
          ) : projects.length === 0 ? (
            <div className="flow-node-copy-notice">{t('flow.copyNodeEmpty')}</div>
          ) : (
            <>
              <div className="flow-node-copy-hint">{t('flow.copyNodeSelectHint')}</div>
              <div className="flow-node-copy-lanes">
                <div className="flow-node-copy-lane">
                  <div className="flow-node-copy-lane-heading">{t('flow.copyNodeColumnProjects')}</div>
                  <div className="flow-node-copy-list">
                    {projects.map((project) => (
                      <button key={project.id} type="button" className="flow-node-copy-item"
                        aria-pressed={activeProjectId === project.id} onClick={() => selectProject(project)}>
                        <span aria-hidden="true">📁</span>
                        <span className="flow-node-copy-item-name">{project.name}</span>
                        <span className="flow-node-copy-item-count">{t('flow.workflowCount', { count: (project.workflows || []).filter((workflow) => !workflow.deleted).length })}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flow-node-copy-lane">
                  <div className="flow-node-copy-lane-heading">{t('flow.copyNodeColumnWorkflows')}</div>
                  <div className="flow-node-copy-list">
                    {!activeProject ? <div className="flow-node-copy-placeholder">{t('flow.copyNodePickProjectHint')}</div>
                      : workflows.length === 0 ? <div className="flow-node-copy-placeholder">{t('flow.copyNodeEmpty')}</div>
                        : workflows.map((workflow) => (
                          <button key={workflow.id} type="button" className="flow-node-copy-item"
                            aria-pressed={activeWorkflowKey === `${activeProject.id}/${workflow.id}`}
                            onClick={() => selectWorkflow(activeProject, workflow)}>
                            <span aria-hidden="true">📂</span>
                            <span className="flow-node-copy-item-name">{workflow.name}{workflow.is_default ? ` ${t('canvas.defaultSuffix')}` : ''}</span>
                            <span className="flow-node-copy-item-count">{t('flow.nodeCount', { count: workflow.nodeCount })}</span>
                          </button>
                        ))}
                  </div>
                </div>
                <div className="flow-node-copy-lane flow-node-copy-steps">
                  <div className="flow-node-copy-lane-heading">{t('flow.copyNodeColumnSteps')}</div>
                  <div className="flow-node-copy-list">
                    {!activeProject ? <div className="flow-node-copy-placeholder">{t('flow.copyNodePickProjectHint')}</div>
                      : !activeWorkflow || !activeWorkflowKey ? <div className="flow-node-copy-placeholder">{t('flow.copyNodePickWorkflowHint')}</div>
                        : workflowLoading === activeWorkflowKey ? <div className="flow-node-copy-placeholder flow-node-copy-loading"><span className="task-status-spinner" aria-hidden="true" />{t('flow.copyNodeLoading')}</div>
                          : workflowErrors[activeWorkflowKey] ? <div className="flow-node-copy-placeholder flow-node-copy-error" role="alert">{workflowErrors[activeWorkflowKey]}</div>
                            : !activeNodes?.length ? <div className="flow-node-copy-placeholder">{t('flow.copyNodeEmpty')}</div>
                              : activeNodes.map((node) => {
                                const sourceKey = `${activeProject.id}/${activeWorkflow.id}/${node.nodeId}`
                                const ports = node.inputs.reduce((sum, input) => sum + (input.outputs?.length || 0), 0)
                                return (
                                  <button key={node.nodeId} type="button" className="flow-node-copy-item"
                                    aria-pressed={selected?.sourceKey === sourceKey}
                                    onClick={() => setSelected({ data: node, sourceKey })}
                                    onDoubleClick={() => onCopy(node)}>
                                    <span className="flow-node-copy-color" style={{ backgroundColor: node.color }} />
                                    <span className="flow-node-copy-item-name">
                                      <span>{node.label}</span>
                                      <span className="flow-node-copy-step-details">{node.key}{node.engine ? ` · ${node.engine}${node.model ? ` / ${node.model}` : ''}` : ''}</span>
                                    </span>
                                    <span className="flow-node-copy-item-count">{t('flow.portCount', { in: node.inputs.length, out: ports })}</span>
                                  </button>
                                )
                              })}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!selected} onClick={() => selected && onCopy(selected.data)}>{t('flow.copyNodeConfirm')}</Button>
        </div>
      </ResizablePanel>
    </div>
  )
}
