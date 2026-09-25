import ResizablePanel from './ResizablePanel'
import { useCompactLayout } from '../hooks/useCompactLayout'
import MobileSheet from './MobileSheet'
import FlowBookmark, { BookmarkContext, loadBookmarks, saveBookmarks } from './FlowBookmark'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Input from './Input'
import Textarea from './Textarea'
import {
  ReactFlow, Controls, Background, addEdge,
  useNodesState, useEdgesState,
  type Node, type Edge, type Connection, type NodeTypes,
  Handle, Position, useReactFlow, ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  engineApi,
  fetchTemplates,
  invalidateTemplates,
  projectApi,
  templateApi,
  workflowApi,
  type EngineInfo,
  type Project,
  type TemplateInfo,
  type WorkflowSummary,
} from '../api/client'
import { DEFAULT_OUTPUT_TYPE } from '../config/outputTypes'
import { DEFAULT_EXECUTION_ENGINE } from '../engineMeta'
import { copyText } from '../utils/clipboard'
import { useI18n } from '../i18n'
import { useEngineRevision } from '../stores/engineAvailabilityStore'
import { findWorkflowExecutionWarnings, type WorkflowExecutionWarning } from '../utils/workflowExecutionWarnings'
import WorkflowExecutionWarningDialog from './WorkflowExecutionWarningDialog'
import { STEP_TYPE_PATTERN, randomStepColor, DEFAULT_MAX_RETURN_ROUNDS, emptyReview, normalizeMaxReturnRounds, canvasToFlowNodes, canvasToFlowEdges, loadCanvasData, type StepNodeData } from './flowCanvasData'
import NodeConfigPanel from './NodeConfigPanel'

/* ══════════════════════════════════════════
   Reusable flow canvas editor — shared by the
   workflow editor page and the settings template
   editor. Owns nodes/edges state, dirty tracking,
   import/export and the node config panel.
   ══════════════════════════════════════════ */

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', fontSize: 'calc(13px * var(--font-scale))', border: 'none', background: 'transparent', color: 'var(--fg)', cursor: 'pointer', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-body)', whiteSpace: 'nowrap' }}
    >
      {children}
    </button>
  )
}

function DropdownMenu({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <>
      <Button variant="ghost" onClick={(e) => {
        if (!open) {
          const rect = e.currentTarget.getBoundingClientRect()
          setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
        }
        setOpen((s) => !s)
      }}>{label}</Button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed', top: pos.top, right: pos.right, zIndex: 1000,
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-raised)',
            padding: 4, minWidth: 160, maxHeight: '60vh', overflowY: 'auto',
          }}
        >
          {children(close)}
        </div>,
        document.body,
      )}
    </>
  )
}

/* ══════════════════════════════════════════
   Step Node component
   ══════════════════════════════════════════ */

const handleStyle: React.CSSProperties = {
  width: 10, height: 10, background: 'var(--bg)', border: '2px solid var(--border)',
  transform: 'translateY(-50%)',
}

/* ── Port layout constants ── */
const NODE_WIDTH = 280
const HEADER_H = 56
const PROMPT_H = 28
const PORT_ROW_H = 20
const SUB_ROW_H = 16
const PORT_PAD = 8

function StepNode({ data }: { data: StepNodeData }) {
  const { t } = useI18n()
  const isDispatch = data.kind === 'task_dispatch'
  const engineText = isDispatch
    ? t('flow.newDispatchStep')
    : data.engine || t('settings.defaultExecutionEngine')
  const hasPrompt = !!data.prompt && !isDispatch
  const topOffset = (hasPrompt ? HEADER_H + PROMPT_H : HEADER_H) + PORT_PAD

  // Calculate Y for each input handle + collect sub-output Y positions
  const inputYs: number[] = []
  const subOutputYs: number[] = [] // flat list of all sub-output Y centers
  let cursor = topOffset
  data.inputs.forEach((inp) => {
    inputYs.push(cursor + PORT_ROW_H / 2)
    cursor += PORT_ROW_H
    inp.outputs.forEach(() => {
      subOutputYs.push(cursor + SUB_ROW_H / 2)
      cursor += SUB_ROW_H
    })
  })

  // Output handles align with sub-outputs (1:1 mapping)
  const outputYs = subOutputYs

  const totalH = Math.max(cursor + PORT_PAD, topOffset + 20)

  return (
    <div style={{
      width: NODE_WIDTH, height: totalH,
      background: 'var(--bg)',
      border: `1.5px solid ${data.color || 'var(--border)'}`,
      borderRadius: 'var(--radius-md)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
      fontFamily: 'var(--font-body)', position: 'relative',
    }}>
      {/* Input handles — one per input */}
      {inputYs.length > 0
        ? inputYs.map((y, i) => (
            <Handle key={`in-${i}`} id={`in-${i}`} type="target" position={Position.Left}
              style={{ ...handleStyle, top: y }} />
          ))
        : <Handle id="in-0" type="target" position={Position.Left} style={{ ...handleStyle, top: '50%' }} />
      }
      {/* Output handles — one per sub-output, aligned to sub-output rows */}
      {!isDispatch && (outputYs.length > 0
        ? outputYs.map((y, i) => (
            <Handle key={`out-${i}`} id={`out-${i}`} type="source" position={Position.Right}
              style={{ ...handleStyle, top: y }} />
          ))
        : <Handle id="out-0" type="source" position={Position.Right} style={{ ...handleStyle, top: '50%' }} />
      )}

      {/* Header */}
      <div style={{ height: HEADER_H, padding: '0 12px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 24, height: 24, flexShrink: 0, borderRadius: 6, background: `${data.color}20`, color: data.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
          {data.label.charAt(0)}
        </div>
        <span title={data.label} style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, lineHeight: 1.3, flex: 1, minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{data.label}</span>
        <span title={engineText} style={{ maxWidth: 96, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'calc(11px * var(--font-scale))', padding: '2px 6px', borderRadius: 4, background: 'var(--surface)', color: 'var(--muted)' }}>{engineText}</span>
      </div>

      {hasPrompt && (
        <div style={{ height: PROMPT_H, padding: '0 12px', fontSize: 'calc(11px * var(--font-scale))', color: 'var(--muted)', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {data.prompt.substring(0, 50)}{data.prompt.length > 50 ? '...' : ''}
        </div>
      )}

      {/* Input labels + sub-output labels — absolute positioned */}
      {data.inputs.map((inp, i) => {
        const labelTop = inputYs[i] - PORT_ROW_H / 2
        return (
          <div key={`inp-${i}`}>
            {/* Input row */}
            <div style={{ position: 'absolute', top: labelTop, left: 14, right: 14, height: PORT_ROW_H, display: 'flex', alignItems: 'center', gap: 4, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--muted)' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inp.name}</span>
              <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', background: 'var(--surface)', padding: '0 3px', borderRadius: 2 }}>{inp.type}</span>
            </div>
            {/* Sub-output rows */}
            {inp.outputs.map((sub, j) => {
              let subTop = labelTop + PORT_ROW_H
              for (let k = 0; k < j; k++) subTop += SUB_ROW_H
              return (
                <div key={`sub-${j}`} style={{ position: 'absolute', top: subTop, left: 28, right: 14, height: SUB_ROW_H, display: 'flex', alignItems: 'center', gap: 3, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>
                  <span>↳</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub.name}</span>
                  <span style={{ fontSize: 'calc(11px * var(--font-scale))', background: 'var(--surface)', padding: '0 2px', borderRadius: 2 }}>{sub.type}</span>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} />
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

const nodeTypes: NodeTypes = { step: StepNode, bookmark: FlowBookmark }

/* ══════════════════════════════════════════
   Flow Canvas component
   ══════════════════════════════════════════ */

export interface FlowCanvasProps {
  /** Canvas JSON ({ nodes, connections } or legacy { steps }). */
  initialSteps?: any
  readOnly?: boolean
  /** Persist the edited canvas; FlowCanvas manages dirty state + toast. */
  onSave: (steps: any) => Promise<void> | void
  onDirtyChange?: (dirty: boolean) => void
  /** Project id — used by MarkdownEditor to upload images into the project. */
  projectId?: string
  workflowId?: string
  /** Toolbar slot rendered before the title (e.g. back button). */
  toolbarLeft?: React.ReactNode
  /** Toolbar slot rendered after the dirty indicator (e.g. workflow switcher). */
  toolbarMid?: React.ReactNode
  /** Toolbar slot on the right, before the built-in canvas actions. */
  toolbarRight?: React.ReactNode
  title?: string
  saveLabel?: string
  hint?: React.ReactNode
  showTemplatePicker?: boolean
  /** Imperative handle: get/validate/replace the canvas steps. */
  ref?: Ref<FlowCanvasHandle>
}

export interface FlowCanvasHandle {
  /** Current canvas steps JSON ({ nodes, connections }). */
  getSteps: () => any
  /** Structural validation; returns an error message or null. */
  validate: () => string | null
  getExecutionWarnings: () => WorkflowExecutionWarning[]
  /** Replace the canvas content (marks the canvas dirty). */
  loadSteps: (steps: any) => void
}

function FlowCanvasInner({
  initialSteps,
  onSave,
  onDirtyChange,
  projectId,
  workflowId,
  toolbarLeft,
  toolbarMid,
  toolbarRight,
  title,
  saveLabel,
  hint,
  showTemplatePicker = true,
  readOnly: requestedReadOnly = false,
  ref,
}: FlowCanvasProps) {
  const { t } = useI18n()
  const compactLayout = useCompactLayout()
  const readOnly = requestedReadOnly
  const { fitView } = useReactFlow()
  const initial = loadCanvasData(initialSteps)
  const [nodes, setNodes, onNodesChange] = useNodesState([...canvasToFlowNodes(initial.nodes), ...loadBookmarks(initialSteps)])
  const [edges, setEdges, onEdgesChange] = useEdgesState(canvasToFlowEdges(initial.connections, initial.nodes))
  const [previewNode, setPreviewNode] = useState<StepNodeData | null>(null)
  const [selectedNode, setSelectedNode] = useState<StepNodeData | null>(null)
  const [nodeConfigDraft, setNodeConfigDraft] = useState<StepNodeData | null>(null)
  const [nodeConfigError, setNodeConfigError] = useState('')
  const [nodeConfigDirty, setNodeConfigDirty] = useState(false)
  const [showJson, setShowJson] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [pendingTemplate, setPendingTemplate] = useState<TemplateInfo | null>(null)
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [showTemplateSave, setShowTemplateSave] = useState(false)
  const [templateSearch, setTemplateSearch] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [templateDesc, setTemplateDesc] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyProjects, setCopyProjects] = useState<Project[]>([])
  const [copyProjectsLoading, setCopyProjectsLoading] = useState(false)
  const [copyProjectsError, setCopyProjectsError] = useState('')
  const [copyActiveProjectId, setCopyActiveProjectId] = useState<string | null>(null)
  const [copyActiveWorkflowKey, setCopyActiveWorkflowKey] = useState<string | null>(null)
  const [copyNodesByWf, setCopyNodesByWf] = useState<Record<string, StepNodeData[]>>({})
  const [copyWfLoading, setCopyWfLoading] = useState<string | null>(null)
  const [copyWfErrors, setCopyWfErrors] = useState<Record<string, string>>({})
  const [copySelected, setCopySelected] = useState<{ data: StepNodeData; srcKey: string } | null>(null)
  const copyStepsCache = useRef<Record<string, StepNodeData[]>>({})
  const [availableEngines, setAvailableEngines] = useState<EngineInfo[]>([])
  const engineRevision = useEngineRevision()
  const [defaultExecutionEngine, setDefaultExecutionEngine] = useState(DEFAULT_EXECUTION_ENGINE)
  const [enginesLoading, setEnginesLoading] = useState(true)
  const [enginesError, setEnginesError] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [saveMsgKind, setSaveMsgKind] = useState<'success' | 'error'>('success')
  const [saveWarnings, setSaveWarnings] = useState<WorkflowExecutionWarning[]>([])
  const [dirty, setDirtyState] = useState(false)

  const setDirty = useCallback((value: boolean) => {
    setDirtyState(value)
    onDirtyChange?.(value)
  }, [onDirtyChange])

  useEffect(() => {
    setEnginesLoading(true)
    engineApi.list()
      .then(({ engines }) => {
        setAvailableEngines(engines)
        setEnginesError('')
      })
      .catch((error) => {
        setAvailableEngines([])
        setEnginesError(error instanceof Error ? error.message : t('common.unknownError'))
      })
      .finally(() => setEnginesLoading(false))
    // engineRevision：设置页改了引擎状态后重新拉取，节点的步骤引擎下拉即时跟随禁用状态。
  }, [engineRevision])

  useEffect(() => {
    engineApi.executionConfig()
      .then((config) => setDefaultExecutionEngine(config.resolved_engine || DEFAULT_EXECUTION_ENGINE))
      .catch(() => setDefaultExecutionEngine(DEFAULT_EXECUTION_ENGINE))
  }, [])

  useEffect(() => {
    fetchTemplates()
      .then(({ templates: list }) => setTemplates(list))
      .catch(() => setTemplates([]))
  }, [])

  // Reload canvas when the source steps change (workflow/template switch)
  const stepsKey = JSON.stringify(initialSteps ?? null)
  const loadedKey = useRef<string | null>(null)
  const savedStepsKey = useRef<string | null>(null)
  useEffect(() => {
    if (loadedKey.current === stepsKey) return
    loadedKey.current = stepsKey
    if (savedStepsKey.current === stepsKey) {
      savedStepsKey.current = null
      return
    }
    savedStepsKey.current = null
    const { nodes: nn, connections: nc } = loadCanvasData(initialSteps)
    setNodes([...canvasToFlowNodes(nn), ...loadBookmarks(initialSteps)])
    setEdges(canvasToFlowEdges(nc, nn))
    setSelectedNode(null)
    setNodeConfigError('')
    setDirty(false)
    setTimeout(() => fitView({ padding: 0.2 }), 100)
  }, [stepsKey]) // eslint-disable-line

  // Warn on page leave when there are unsaved changes
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // Keyboard: Delete selected
  useEffect(() => {
    if (readOnly) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        const deletedNodeIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id))
        if (deletedNodeIds.size > 0 || edges.some((edge) => edge.selected)) setDirty(true)
        setNodes((nds) => nds.filter((node) => !deletedNodeIds.has(node.id)))
        setEdges((eds) => eds.filter((edge) => (
          !edge.selected
          && !deletedNodeIds.has(edge.source)
          && !deletedNodeIds.has(edge.target)
        )))
        if (selectedNode && deletedNodeIds.has(String(selectedNode.nodeId))) {
          setSelectedNode(null)
          setNodeConfigError('')
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setNodes, setEdges, readOnly, nodes, edges, selectedNode, setDirty])

  const onEdgeDoubleClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setEdges((eds) => eds.filter((e) => e.id !== edge.id))
  }, [setEdges])

  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.type === 'bookmark') return
    setSelectedNode(node.data as StepNodeData)
    setContextMenu(null)
  }, [])

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault()
    if (node.type === 'bookmark') return
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
  }, [])

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId))
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
    if (selectedNode && String(selectedNode.nodeId) === nodeId) {
      setSelectedNode(null)
      setNodeConfigError('')
    }
    setContextMenu(null)
  }, [setNodes, setEdges, selectedNode])

  const handleAddNode = () => {
    const id = Date.now()
    const maxId = Math.max(0, ...nodes.map((n) => (n.data as StepNodeData).nodeId))
    const nodeId = maxId + 1
    const newNode: Node = {
      id: String(nodeId), type: 'step',
      position: { x: 300 + Math.random() * 200, y: 150 + Math.random() * 200 },
      data: { nodeId, key: `step_${id}`, label: t('flow.newStep'), kind: 'llm', autoStart: false, engine: '', model: '', color: randomStepColor(), prompt: '', maxReturnRounds: DEFAULT_MAX_RETURN_ROUNDS, review: { mode: 'manual', auto: false, maxRetries: 1, engine: '', model: '', prompt: '' }, inputs: [{ name: 'input', type: DEFAULT_OUTPUT_TYPE, outputs: [{ name: 'output', type: DEFAULT_OUTPUT_TYPE }] }], outputs: [{ name: 'output', type: DEFAULT_OUTPUT_TYPE }] } as StepNodeData,
    }
    setNodes((nds) => [...nds, newNode])
  }

  const handleAddDispatchNode = () => {
    const id = Date.now()
    const maxId = Math.max(0, ...nodes.map((n) => (n.data as StepNodeData).nodeId))
    const nodeId = maxId + 1
    const newNode: Node = {
      id: String(nodeId), type: 'step',
      position: { x: 300 + Math.random() * 200, y: 150 + Math.random() * 200 },
      data: {
        nodeId, key: `handoff_${id}`, label: t('flow.newDispatchStep'), kind: 'task_dispatch', color: '#eb6c36', engine: '', model: '', prompt: '', maxReturnRounds: DEFAULT_MAX_RETURN_ROUNDS,
        inputs: [{ name: t('flow.upstreamInputs'), type: DEFAULT_OUTPUT_TYPE, outputs: [] }], outputs: [], config: {},
        dispatch: { targetProjectId: '', targetWorkflowId: '', targetStartStepKey: '', startMode: 'inherit' },
      } as StepNodeData,
    }
    setNodes((nds) => [...nds, newNode])
    setDirty(true)
  }

  const loadCopyWorkflow = async (srcProjectId: string, workflowId: string) => {
    const cacheKey = `${srcProjectId}/${workflowId}`
    if (copyStepsCache.current[cacheKey]) {
      setCopyNodesByWf((prev) => ({ ...prev, [cacheKey]: copyStepsCache.current[cacheKey] }))
      setCopyWfErrors((prev) => { const next = { ...prev }; delete next[cacheKey]; return next })
      return
    }
    setCopyWfLoading(cacheKey)
    setCopyWfErrors((prev) => { const next = { ...prev }; delete next[cacheKey]; return next })
    try {
      const wf = await workflowApi.get(workflowId, srcProjectId)
      const list = loadCanvasData(wf.steps).nodes
      copyStepsCache.current[cacheKey] = list
      setCopyNodesByWf((prev) => ({ ...prev, [cacheKey]: list }))
    } catch (error) {
      setCopyWfErrors((prev) => ({
        ...prev,
        [cacheKey]: t('flow.copyNodeFailed', { error: error instanceof Error ? error.message : t('flow.networkError') }),
      }))
    } finally {
      setCopyWfLoading((prev) => (prev === cacheKey ? null : prev))
    }
  }

  const openCopyModal = async () => {
    setCopyOpen(true)
    setCopySelected(null)
    setCopyProjectsLoading(true)
    setCopyProjectsError('')
    try {
      const { projects } = await projectApi.list()
      setCopyProjects(projects)
      const first = projects[0]
      if (first) {
        setCopyActiveProjectId(first.id)
        const firstWf = (first.workflows || []).find((w) => !w.deleted)
        if (firstWf) {
          const firstKey = `${first.id}/${firstWf.id}`
          setCopyActiveWorkflowKey(firstKey)
          void loadCopyWorkflow(first.id, firstWf.id)
        } else {
          setCopyActiveWorkflowKey(null)
        }
      } else {
        setCopyActiveProjectId(null)
        setCopyActiveWorkflowKey(null)
      }
    } catch (error) {
      setCopyProjects([])
      setCopyProjectsError(t('flow.copyNodeFailed', { error: error instanceof Error ? error.message : t('flow.networkError') }))
    } finally {
      setCopyProjectsLoading(false)
    }
  }

  const selectCopyProject = (proj: Project) => {
    setCopyActiveProjectId(proj.id)
    setCopySelected(null)
    const firstWf = (proj.workflows || []).find((w) => !w.deleted)
    if (firstWf) {
      const key = `${proj.id}/${firstWf.id}`
      setCopyActiveWorkflowKey(key)
      void loadCopyWorkflow(proj.id, firstWf.id)
    } else {
      setCopyActiveWorkflowKey(null)
    }
  }

  const selectCopyWorkflow = (proj: Project, wf: WorkflowSummary) => {
    const key = `${proj.id}/${wf.id}`
    setCopyActiveWorkflowKey(key)
    setCopySelected(null)
    if (!copyStepsCache.current[key]) void loadCopyWorkflow(proj.id, wf.id)
  }

  const handleCopyNode = (source: StepNodeData) => {
    const id = Date.now()
    const maxId = Math.max(0, ...nodes.map((n) => (n.data as StepNodeData).nodeId))
    const nodeId = maxId + 1
    const newNode: Node = {
      id: String(nodeId), type: 'step',
      position: { x: 300 + Math.random() * 200, y: 150 + Math.random() * 200 },
      data: {
        ...source,
        nodeId,
        key: `step_${id}`,
        inputs: JSON.parse(JSON.stringify(source.inputs || [])),
        outputs: JSON.parse(JSON.stringify(source.outputs || [])),
        review: source.review ? JSON.parse(JSON.stringify(source.review)) : { mode: 'manual', auto: false, maxRetries: 1, engine: '', model: '', prompt: '' },
        maxReturnRounds: normalizeMaxReturnRounds(source.maxReturnRounds),
      } as StepNodeData,
    }
    setNodes((nds) => [...nds, newNode])
    setDirty(true)
    setCopyOpen(false)
    setCopySelected(null)
    setSaveMsg(t('flow.copyNodeDone'))
    setSaveMsgKind('success')
    setTimeout(() => setSaveMsg(''), 5000)
  }

  const handleAutoLayout = useCallback(() => {
    const stepNodes = nodes.filter(node => node.type !== 'bookmark')
    const levels: Record<string, number> = {}
    const inDeg: Record<string, number> = {}
    stepNodes.forEach((n) => { inDeg[n.id] = 0 })
    edges.forEach((e) => { inDeg[e.target] = (inDeg[e.target] || 0) + 1 })

    const queue = stepNodes.filter((n) => inDeg[n.id] === 0).map((n) => n.id)
    const visited = new Set<string>()
    while (queue.length > 0) {
      const nid = queue.shift()!
      if (visited.has(nid)) continue
      visited.add(nid)
      const lvl = levels[nid] || 0
      edges.filter((e) => e.source === nid).forEach((e) => {
        levels[e.target] = Math.max(levels[e.target] || 0, lvl + 1)
        inDeg[e.target]--
        if (inDeg[e.target] === 0) queue.push(e.target)
      })
    }
    stepNodes.forEach((n) => { if (levels[n.id] === undefined) levels[n.id] = 0 })

    const groups: Record<number, string[]> = {}
    stepNodes.forEach((n) => {
      const l = levels[n.id]
      if (!groups[l]) groups[l] = []
      groups[l].push(n.id)
    })

    setNodes((nds) => nds.map((n) => ({
      ...n,
      position: n.type === 'bookmark' ? n.position : { x: 100 + (levels[n.id] || 0) * 320, y: 100 + (groups[levels[n.id] || 0]?.indexOf(n.id) || 0) * 180 },
    })))
    setTimeout(() => fitView({ padding: 0.2 }), 100)
  }, [nodes, edges, setNodes, fitView])

  // Build canvas-editor JSON for save/preview
  const buildCanvasJsonFromNodes = (nds: typeof nodes, conns: typeof edges) => {
    const idToNum = new Map(nds.map((n) => [n.id, (n.data as StepNodeData).nodeId]))
    const nodesArr = nds.filter(n => n.type !== 'bookmark').map((n) => {
      const d = n.data as StepNodeData
      return {
        id: d.nodeId, type: d.key, title: d.label, color: d.color,
        autoStart: Boolean(d.autoStart),
        position: n.position, engine: d.engine, model: d.model,
        prompt: d.prompt,
        kind: d.kind || 'llm',
        dispatch: d.dispatch,
        quickButtons: d.quickButtons || [],
        config: d.config || {},
        maxReturnRounds: normalizeMaxReturnRounds(d.maxReturnRounds),
        review: d.review || emptyReview(),
        inputs: d.inputs, outputs: d.outputs,
      }
    })
    const connsArr = conns.filter((edge) => (
      idToNum.has(edge.source) && idToNum.has(edge.target)
    )).map((e) => {
      const sourceHandle = e.sourceHandle || 'out-0'
      const targetHandle = e.targetHandle || 'in-0'
      return {
        from: idToNum.get(e.source) || 0,
        fromPort: parseInt(sourceHandle.replace('out-', '')) || 0,
        to: idToNum.get(e.target) || 0,
        toPort: parseInt(targetHandle.replace('in-', '')) || 0,
        kind: (e.data as { kind?: string })?.kind === 'dashed' ? 'dashed' : 'solid',
      }
    })
    return { nodes: nodesArr, connections: connsArr, bookmarks: saveBookmarks(nds), inheritProjectQuickButtons: initialSteps?.inheritProjectQuickButtons === true, ...(Array.isArray(initialSteps?.projectQuickButtonIds) ? { projectQuickButtonIds: initialSteps.projectQuickButtonIds } : {}), quickButtons: Array.isArray(initialSteps?.quickButtons) ? initialSteps.quickButtons : [] }
  }
  const buildCanvasJson = () => buildCanvasJsonFromNodes(nodes, edges)

  const computeStepError = (candidateNodes = nodes): string | null => {
    if (nodeConfigError) return t('flow.stepConfigIncomplete', { error: nodeConfigError })
    const stepTypes = candidateNodes.filter(node => node.type !== 'bookmark').map((node, index) => {
      const data = node.data as StepNodeData
      return {
        index,
        label: data.label || t('flow.stepN', { index: index + 1 }),
        value: (data.key ?? '').trim(),
      }
    })
    const missingType = stepTypes.find((step) => !step.value)
    if (missingType) {
      return t('flow.stepTypeRequired', { label: missingType.label })
    }
    const missingDispatch = candidateNodes.find((node) => {
      const data = node.data as StepNodeData
      return data.kind === 'task_dispatch' && (!data.dispatch?.targetProjectId || !data.dispatch.targetWorkflowId || !data.dispatch.targetStartStepKey)
    })
    if (missingDispatch) return t('flow.dispatchConfigRequired')
    const invalidType = stepTypes.find((step) => !STEP_TYPE_PATTERN.test(step.value))
    if (invalidType) {
      return t('flow.stepTypeInvalid', { label: invalidType.label })
    }
    const seenTypes = new Map<string, string>()
    for (const step of stepTypes) {
      const previousLabel = seenTypes.get(step.value)
      if (previousLabel) {
        return t('flow.stepTypeDuplicate', { type: step.value, prev: previousLabel, label: step.label })
      }
      seenTypes.set(step.value, step.label)
    }
    return null
  }

  useImperativeHandle(ref, () => ({
    getSteps: () => buildCanvasJson(),
    validate: () => computeStepError(),
    getExecutionWarnings: () => findWorkflowExecutionWarnings(buildCanvasJson()),
    loadSteps: (steps: any) => {
      const { nodes: nn, connections: nc } = loadCanvasData(steps)
      setNodes([...canvasToFlowNodes(nn), ...loadBookmarks(steps)])
      setEdges(canvasToFlowEdges(nc, nn))
      setSelectedNode(null)
      setNodeConfigError('')
      setDirty(true)
      setTimeout(() => fitView({ padding: 0.2 }), 100)
    },
  }), [nodes, edges, nodeConfigError, ref, readOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyTemplate = async (template: TemplateInfo) => {
    try {
      const full = await templateApi.get(template.id)
      const { nodes: tNodes, connections: tConns } = loadCanvasData(full.steps ?? full)
      setNodes([...canvasToFlowNodes(tNodes), ...loadBookmarks(full.steps ?? full)])
      setEdges(canvasToFlowEdges(tConns, tNodes))
      setSelectedNode(null)
      setNodeConfigError('')
      setDirty(true)
      setTimeout(() => fitView({ padding: 0.2 }), 100)
    } catch (e) {
      setSaveMsg(t('flow.templateLoadFailed', { error: e instanceof Error ? e.message : t('flow.networkError') }))
      setSaveMsgKind('error')
      setTimeout(() => setSaveMsg(''), 5000)
    }
  }

  const saveCurrentAsTemplate = async () => {
    const name = templateName.trim()
    if (!name) {
      setSaveMsg(t('flow.saveTemplateNameRequired'))
      setSaveMsgKind('error')
      setTimeout(() => setSaveMsg(''), 5000)
      return
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const id = slug || `custom-${Date.now()}`
    try {
      await templateApi.save({
        id,
        name,
        description: templateDesc.trim(),
        steps: buildCanvasJson(),
      })
      invalidateTemplates()
      const { templates: list } = await fetchTemplates(true)
      setTemplates(list)
      setShowTemplateSave(false)
      setTemplateName('')
      setTemplateDesc('')
      setShowTemplateModal(false)
      setSaveMsg(t('flow.templateSaved', { name }))
      setSaveMsgKind('success')
      setTimeout(() => setSaveMsg(''), 5000)
    } catch (e) {
      setSaveMsg(t('flow.saveFailed', { error: e instanceof Error ? e.message : t('flow.networkError') }))
      setSaveMsgKind('error')
      setTimeout(() => setSaveMsg(''), 5000)
    }
  }

  const onConnect = useCallback((params: Connection) => {
    const { source, target } = params
    if (!source || !target || source === target) return  // self-loop is invalid
    const sourceNode = nodes.find((node) => node.id === source)
    if ((sourceNode?.data as StepNodeData | undefined)?.kind === 'task_dispatch') return
    setEdges((eds) => {
      // A solid edge source -> target would create a cycle iff `target` can
      // already reach `source` through existing solid edges. In that case the
      // new connection is a rework-feedback edge and becomes dashed.
      const solidFrom = new Map<string, string[]>()
      for (const ed of eds) {
        if (ed.data?.kind === 'dashed') continue
        const list = solidFrom.get(ed.source) || []
        list.push(ed.target)
        solidFrom.set(ed.source, list)
      }
      const visited = new Set<string>()
      const stack = [target]
      let wouldCycle = false
      while (stack.length) {
        const key = stack.pop()!
        if (key === source) { wouldCycle = true; break }
        if (visited.has(key)) continue
        visited.add(key)
        stack.push(...(solidFrom.get(key) || []))
      }
      const kind = wouldCycle ? 'dashed' : 'solid'
      return addEdge({
        ...params,
        data: { kind },
        style: kind === 'dashed'
          ? { stroke: 'var(--warn)', strokeWidth: 2, strokeDasharray: '8 4' }
          : { stroke: 'var(--accent)', strokeWidth: 2 },
      }, eds)
    })
    setDirty(true)
  }, [nodes, setEdges, setDirty])

  const handleSave = async (confirmedWarnings = false) => {
    if (readOnly) return
    const activeDraft = selectedNode && nodeConfigDraft?.nodeId === selectedNode.nodeId
      ? { ...nodeConfigDraft, key: (nodeConfigDraft.key ?? '').trim() }
      : null
    const nodesToSave = activeDraft
      ? nodes.map((node) => node.id === String(activeDraft.nodeId) ? { ...node, data: activeDraft } : node)
      : nodes
    const stepError = computeStepError(nodesToSave)
    if (stepError) {
      setSaveMsg(t('flow.saveFailed', { error: stepError }))
      setSaveMsgKind('error')
      setTimeout(() => setSaveMsg(''), 5000)
      return
    }

    const steps = buildCanvasJsonFromNodes(nodesToSave, edges)
    const warnings = findWorkflowExecutionWarnings(steps)
    if (warnings.length && !confirmedWarnings) {
      setSaveWarnings(warnings)
      return
    }
    try {
      savedStepsKey.current = JSON.stringify(steps)
      await onSave(steps)
      if (activeDraft) {
        setNodes(nodesToSave)
        setSelectedNode(activeDraft)
        setNodeConfigDraft(activeDraft)
        setNodeConfigDirty(false)
      }
      setDirty(false)
      setSaveMsg(t('flow.saveSuccess'))
      setSaveMsgKind('success')
      setTimeout(() => setSaveMsg(''), 2000)
    } catch (e) {
      savedStepsKey.current = null
      console.error('Save failed:', e)
      setSaveMsg(t('flow.saveFailed', { error: e instanceof Error ? e.message : t('flow.networkError') }))
      setSaveMsgKind('error')
      setTimeout(() => setSaveMsg(''), 5000)
    }
  }

  const handleExportJson = () => {
    const text = JSON.stringify(buildCanvasJson(), null, 2)
    setShowJson(true)
    void copyText(text).then((ok) => {
      setSaveMsg(ok ? t('flow.copyJsonSuccess') : t('flow.copyJsonFailedHint'))
      setSaveMsgKind(ok ? 'success' : 'error')
    })
    setTimeout(() => setSaveMsg(''), 3000)
  }

  const handleCopyJson = () => {
    void copyText(JSON.stringify(buildCanvasJson(), null, 2)).then((ok) => {
      setSaveMsg(ok ? t('flow.copyJsonSuccess') : t('flow.copyFailed'))
      setSaveMsgKind(ok ? 'success' : 'error')
    })
    setTimeout(() => setSaveMsg(''), 3000)
  }

  const handleImport = () => {
    try {
      const parsed = JSON.parse(importText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(t('flow.jsonShapeError'))
      }
      const { nodes: impNodes, connections: impConns } = loadCanvasData(parsed)
      setNodes([...canvasToFlowNodes(impNodes), ...loadBookmarks(parsed)])
      setEdges(canvasToFlowEdges(impConns, impNodes))
      setSelectedNode(null)
      setNodeConfigError('')
      setDirty(true)
      setShowImport(false)
      setImportText('')
      setImportError('')
      setTimeout(() => fitView({ padding: 0.2 }), 100)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : t('flow.jsonParseError'))
    }
  }

  useEffect(() => {
    if (!contextMenu) return
    const handler = () => setContextMenu(null)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [contextMenu])

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Toast notification */}
      {saveMsg && (
        <div style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 600,
          padding: '8px 20px', borderRadius: 'var(--radius-sm)',
          background: saveMsgKind === 'success' ? 'var(--success)' : 'var(--danger)',
          color: 'var(--accent-fg)', fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          {saveMsg}
        </div>
      )}

      <MobileSheet open={readOnly && Boolean(previewNode)} title={previewNode?.label || t('mobile.viewNode')} onClose={() => setPreviewNode(null)}>
        {previewNode && <dl className="mobile-node-config">
          <div><dt>{t('flow.stepKey')}</dt><dd>{previewNode.key}</dd></div>
          <div><dt>{t('flow.autoStart')}</dt><dd>{t(previewNode.autoStart ? 'common.yes' : 'common.no')}</dd></div>
          {previewNode.kind === 'task_dispatch' ? <div><dt>{t('flow.dispatchTarget')}</dt><dd><pre>{JSON.stringify(previewNode.dispatch, null, 2)}</pre></dd></div> : <>
            <div><dt>{t('flow.engine')}</dt><dd>{previewNode.engine || t('settings.defaultExecutionEngine')}</dd></div>
            <div><dt>{t('flow.modelOptional')}</dt><dd>{previewNode.model || t('flow.engineDefaultModel')}</dd></div>
            <div><dt>{t('flow.prompt')}</dt><dd className="mobile-node-prompt">{previewNode.prompt || t('common.none')}</dd></div>
            {Object.keys(previewNode.config || {}).length > 0 && <div><dt>{t('flow.stepConfig')}</dt><dd><pre>{JSON.stringify(previewNode.config, null, 2)}</pre></dd></div>}
            <div><dt>{t('flow.stepReview')}</dt><dd>{t(previewNode.review?.auto ? 'flow.autoReview' : 'flow.manualReview')}</dd></div>
            {previewNode.review?.prompt && <div><dt>{t('flow.reviewPrompt')}</dt><dd className="mobile-node-prompt">{previewNode.review.prompt}</dd></div>}
          </>}
          <div><dt>{t('flow.inputArtifacts')}</dt><dd>{previewNode.inputs?.map(input => input.name).join('、') || t('common.none')}</dd></div>
          <div><dt>{t('flow.outputName')}</dt><dd>{previewNode.outputs?.map(output => output.name).join('、') || t('common.none')}</dd></div>
        </dl>}
      </MobileSheet>
      {/* Toolbar */}
      <div className="flow-canvas-toolbar" style={{ height: 48, background: 'var(--bg)', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', padding: '0 10px', gap: 8, flexShrink: 0, overflowX: 'auto' }}>
        {toolbarLeft && <div className="flow-canvas-toolbar-slot flow-canvas-toolbar-left">{toolbarLeft}</div>}
        <span className="flow-canvas-toolbar-title" style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'calc(13px * var(--font-scale))', whiteSpace: 'nowrap' }}>{title ?? t('flow.editorTitle')}</span>
        {toolbarMid && <div className="flow-canvas-toolbar-slot flow-canvas-toolbar-mid">{toolbarMid}</div>}
        <div className="flow-canvas-toolbar-spacer" />
        {toolbarRight && <div className="flow-canvas-toolbar-slot flow-canvas-toolbar-right">{toolbarRight}</div>}
        {dirty && <span style={{ color: 'var(--warn-text)', fontSize: 'calc(11px * var(--font-scale))', marginLeft: 12 }}>{t('flow.dirtyHint')}</span>}
         {hint !== undefined && <span style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)', marginRight: 10 }}>{hint ?? t('flow.hint')}</span>}
        {!readOnly && <>
        {showTemplatePicker && <Button variant="ghost" onClick={() => { setShowTemplateModal(true); setTemplateSearch('') }}>{t('flow.templates')}</Button>}
        <DropdownMenu label="JSON ▾">
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); handleExportJson() }}>{t('flow.exportJson')}</MenuItem>
              <MenuItem onClick={() => { close(); setImportText(''); setImportError(''); setShowImport(true) }}>{t('flow.importJson')}</MenuItem>
            </>
          )}
        </DropdownMenu>
        <Button variant="ghost" onClick={handleAutoLayout}>{t('flow.layout')}</Button>
        <DropdownMenu label={`${t('flow.addStep')} ▾`}>
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); handleAddNode() }}>{t('flow.addStep')}</MenuItem>
              <MenuItem onClick={() => { close(); handleAddDispatchNode() }}>{t('flow.addDispatchStep')}</MenuItem>
              <MenuItem onClick={() => {
                close()
                const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
                setNodes(nds => [...nds, ...loadBookmarks({ bookmarks: [{ id, text: '', position: { x: 300, y: 150 } }] })])
                setDirty(true)
                setTimeout(() => fitView({ padding: 0.2 }), 100)
              }}>{t('flow.bookmark')}</MenuItem>
              <MenuItem onClick={() => { close(); void openCopyModal() }}>{t('flow.copyNodeFromWorkflow')}</MenuItem>
            </>
          )}
        </DropdownMenu>
        <Button variant="primary" onClick={() => void handleSave()} style={dirty ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}>{saveLabel ?? t('common.save')}</Button>
        </>}
      </div>
      {readOnly && <p className="mobile-canvas-notice" role="status">{t('mobile.canvasReadOnly')}</p>}

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1 }} onClick={() => { if (selectedNode && !nodeConfigDirty) { setNodeConfigError(""); setSelectedNode(null); setNodeConfigDirty(false); } } }>
          <BookmarkContext.Provider value={{ readOnly, onChange: () => setDirty(true) }}>
          <ReactFlow className="flow-canvas-workspace" nodes={nodes} edges={edges}
            onNodesChange={readOnly ? changes => onNodesChange(changes.filter(change => change.type === 'dimensions' || change.type === 'select')) : changes => { onNodesChange(changes); if (changes.some(change => change.type === 'position' || change.type === 'remove' || (change.type === 'dimensions' && Boolean(change.resizing)))) setDirty(true) }} onEdgesChange={readOnly ? undefined : onEdgesChange}
            nodesDraggable={!readOnly} nodesConnectable={!readOnly} edgesReconnectable={!readOnly}
            onNodeClick={compactLayout && !readOnly
              ? (event, node) => {
                  event.stopPropagation()
                  if (node.type === 'bookmark') return
                  setSelectedNode(node.data as StepNodeData)
                  setNodeConfigDirty(false)
                }
              : readOnly
                ? (event, node) => { event.stopPropagation(); if (node.type !== 'bookmark') setPreviewNode(node.data as StepNodeData) }
                : undefined}
            onConnect={readOnly ? undefined : onConnect} onNodeDoubleClick={readOnly ? undefined : onNodeDoubleClick}
            onNodeContextMenu={readOnly ? undefined : onNodeContextMenu} onEdgeDoubleClick={readOnly ? undefined : onEdgeDoubleClick}
            nodeTypes={nodeTypes} fitView minZoom={0.1} deleteKeyCode={null}
            connectionLineStyle={{ stroke: 'var(--meta)', strokeWidth: 2, strokeDasharray: '5 5' }}
            style={{ background: 'var(--surface)' }}>
            <Controls position="top-right" showInteractive={!readOnly} /><Background gap={20} size={1} color="var(--border)" />
          </ReactFlow>
          </BookmarkContext.Provider>
        </div>

        {/* Config panel */}
        {selectedNode && (
          <div style={{ display: readOnly ? 'none' : 'contents' }}>
          <NodeConfigPanel
            node={selectedNode}
            engines={availableEngines}
            enginesLoading={enginesLoading}
            enginesError={enginesError}
            defaultExecutionEngine={defaultExecutionEngine}
            unavailableKeys={nodes
              .map((node) => node.data as StepNodeData)
              .filter((node) => node.nodeId !== selectedNode.nodeId)
              .map((node) => node.key)}
            onValidationChange={setNodeConfigError}
            onDraftChange={setNodeConfigDraft}
            onSave={(data) => {
              setNodes((nds) => nds.map((n) =>
                n.id === String(data.nodeId) ? { ...n, data } : n
              ))
              setSelectedNode(data)
              setNodeConfigDraft(data)
              setNodeConfigError('')
              setDirty(true)
            }}
            onRequestDelete={() => setConfirmDeleteId(String(selectedNode.nodeId))}
            onDirtyChange={setNodeConfigDirty}
            projectId={projectId}
            workflowId={workflowId}
            onClose={() => {
              setNodeConfigError('')
              setSelectedNode(null)
            }}
          />
          </div>
        )}
      </div>

      {/* Context menu */}
      {!readOnly && contextMenu && (
        <div style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-raised)', padding: '4px 0', zIndex: 500, minWidth: 140 }}>
          <div onClick={() => { const n = nodes.find((nd) => nd.id === contextMenu.nodeId); if (n) { setSelectedNode(n.data as StepNodeData); setNodeConfigDirty(false); } setContextMenu(null) }}
            style={{ padding: '8px 16px', fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
            {t('flow.editStep')}
          </div>
          <div onClick={() => { setConfirmDeleteId(contextMenu.nodeId); setContextMenu(null) }}
            style={{ padding: '8px 16px', fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer', color: 'var(--danger)' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
            🗑 {t('common.delete')}
          </div>
        </div>
      )}

      {/* Template list modal */}
      {!readOnly && showTemplatePicker && showTemplateModal && (
        <div className="modal-overlay" onClick={() => setShowTemplateModal(false)} style={{ zIndex: 400 }}>
          <ResizablePanel className="modal" style={{ width: 520, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{t('flow.templates')}</span>
              <Button variant="icon" onClick={() => setShowTemplateModal(false)}>✕</Button>
            </div>
            <div className="modal-body" style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
              <Input
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                placeholder={t('flow.searchTemplates')}
                spellCheck={false}
                style={{ marginBottom: 10 }}
              />
              {showTemplateSave && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 10, background: 'var(--surface)' }}>
                  <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, marginBottom: 8 }}>{t('flow.saveCanvasAsTemplate')}</div>
                  <Input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder={t('flow.templateNameRequired')}
                    spellCheck={false}
                  />
                  <Input
                    value={templateDesc}
                    onChange={(e) => setTemplateDesc(e.target.value)}
                    placeholder={t('flow.templateDescOptional')}
                    spellCheck={false}
                    style={{ marginTop: 8 }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <Button variant="primary" onClick={() => void saveCurrentAsTemplate()} disabled={!templateName.trim()}>{t('flow.saveTemplate')}</Button>
                    <Button variant="ghost" onClick={() => setShowTemplateSave(false)}>{t('common.cancel')}</Button>
                  </div>
                </div>
              )}
              {templates.length === 0 && (
                <div style={{ padding: '12px 4px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)' }}>{t('flow.noTemplates')}</div>
              )}
              {(() => {
                const query = templateSearch.trim().toLowerCase()
                const filtered = templates.filter((t) =>
                  !query ||
                  t.name.toLowerCase().includes(query) ||
                  (t.description || '').toLowerCase().includes(query) ||
                  t.id.toLowerCase().includes(query),
                )
                if (templates.length > 0 && filtered.length === 0) {
                  return <div style={{ padding: '12px 4px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)' }}>{t('flow.noMatchingTemplates')}</div>
                }
                return filtered.map((template) => (
                <button
                  key={template.id}
                  onClick={() => { setShowTemplateModal(false); setPendingTemplate(template) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 6, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface)', color: 'var(--fg)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 'calc(13px * var(--font-scale))' }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 500 }}>{template.name}</span>
                    {template.description && (
                      <span style={{ display: 'block', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.description}</span>
                    )}
                  </span>
                  <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', flexShrink: 0 }}>{t('flow.nodeCount', { count: template.nodeCount })}</span>
                </button>
                ))
              })()}
            </div>
            <div className="modal-footer">
              <Button variant="primary" onClick={() => setShowTemplateSave(true)}>{t('flow.saveAsTemplate')}</Button>
              <Button variant="ghost" onClick={() => setShowTemplateModal(false)}>{t('common.cancel')}</Button>
            </div>
          </ResizablePanel>
        </div>
      )}

      {/* Copy node from existing workflow — 3-lane swimlane picker: project → workflow → step */}
      {!readOnly && copyOpen && (
        <div className="modal-overlay" onClick={() => setCopyOpen(false)} style={{ zIndex: 400 }}>
          <ResizablePanel className="modal" style={{ width: 780, height: 'min(66vh, 620px)' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{t('flow.copyNodeTitle')}</span>
              <Button variant="icon" onClick={() => setCopyOpen(false)}>✕</Button>
            </div>
            <div className="modal-body" style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
              {copyProjectsLoading ? (
                <div style={{ padding: '12px 4px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="task-status-spinner" aria-hidden="true" />{t('flow.copyNodeLoading')}
                </div>
              ) : copyProjectsError ? (
                <div style={{ padding: '12px 4px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)' }}>{copyProjectsError}</div>
              ) : copyProjects.length === 0 ? (
                <div style={{ padding: '12px 4px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)' }}>{t('flow.copyNodeEmpty')}</div>
              ) : (
                <>
                  <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)', marginBottom: 6 }}>{t('flow.copyNodeSelectHint')}</div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flex: 1, minHeight: 0 }}>
                    {/* Lane 1: projects */}
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface)', overflow: 'hidden' }}>
                      <div style={{ padding: '7px 10px', fontSize: 'calc(12px * var(--font-scale))', fontWeight: 600, color: 'var(--meta)', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)' }}>{t('flow.copyNodeColumnProjects')}</div>
                      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                        {copyProjects.map((proj) => {
                          const active = copyActiveProjectId === proj.id
                          const wfs = (proj.workflows || []).filter((w) => !w.deleted)
                          return (
                            <button
                              key={proj.id}
                              onClick={() => selectCopyProject(proj)}
                              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '9px 10px', border: 'none', borderBottom: '1px solid var(--border-soft)', background: active ? 'color-mix(in oklab, var(--accent), transparent 92%)' : 'transparent', color: 'var(--fg)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 'calc(13px * var(--font-scale))' }}
                            >
                              <span style={{ flexShrink: 0 }}>📁</span>
                              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proj.name}</span>
                              <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', flexShrink: 0 }}>{t('flow.workflowCount', { count: wfs.length })}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                    {/* Lane 2: workflows */}
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface)', overflow: 'hidden' }}>
                      <div style={{ padding: '7px 10px', fontSize: 'calc(12px * var(--font-scale))', fontWeight: 600, color: 'var(--meta)', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)' }}>{t('flow.copyNodeColumnWorkflows')}</div>
                      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                        {(() => {
                          const proj = copyProjects.find((p) => p.id === copyActiveProjectId)
                          if (!proj) return <div style={{ padding: '10px', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)' }}>{t('flow.copyNodePickProjectHint')}</div>
                          const wfs = (proj.workflows || []).filter((w) => !w.deleted)
                          if (wfs.length === 0) return <div style={{ padding: '10px', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)' }}>{t('flow.copyNodeEmpty')}</div>
                          return wfs.map((wf) => {
                            const key = `${proj.id}/${wf.id}`
                            const active = copyActiveWorkflowKey === key
                            return (
                              <button
                                key={wf.id}
                                onClick={() => selectCopyWorkflow(proj, wf)}
                                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '9px 10px', border: 'none', borderBottom: '1px solid var(--border-soft)', background: active ? 'color-mix(in oklab, var(--accent), transparent 92%)' : 'transparent', color: 'var(--fg)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 'calc(13px * var(--font-scale))' }}
                              >
                                <span style={{ flexShrink: 0 }}>📂</span>
                                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wf.name}{wf.is_default ? ` ${t('canvas.defaultSuffix')}` : ''}</span>
                                <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', flexShrink: 0 }}>{t('flow.nodeCount', { count: wf.nodeCount })}</span>
                              </button>
                            )
                          })
                        })()}
                      </div>
                    </div>
                    {/* Lane 3: steps */}
                    <div style={{ flex: 1.2, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface)', overflow: 'hidden' }}>
                      <div style={{ padding: '7px 10px', fontSize: 'calc(12px * var(--font-scale))', fontWeight: 600, color: 'var(--meta)', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)' }}>{t('flow.copyNodeColumnSteps')}</div>
                      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                        {(() => {
                          const proj = copyProjects.find((p) => p.id === copyActiveProjectId)
                          if (!proj) return <div style={{ padding: '10px', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)' }}>{t('flow.copyNodePickProjectHint')}</div>
                          const activeWfKey = copyActiveWorkflowKey
                          const activeWf = (proj.workflows || []).find((w) => !w.deleted && `${proj.id}/${w.id}` === activeWfKey)
                          if (!activeWf || !activeWfKey) return <div style={{ padding: '10px', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)' }}>{t('flow.copyNodePickWorkflowHint')}</div>
                          const loading = copyWfLoading === activeWfKey
                          const err = copyWfErrors[activeWfKey]
                          const nodesList = copyNodesByWf[activeWfKey]
                          if (loading) return (
                            <div style={{ padding: '10px', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)', display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span className="task-status-spinner" aria-hidden="true" />{t('flow.copyNodeLoading')}
                            </div>
                          )
                          if (err) return <div style={{ padding: '10px', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--danger)' }}>{err}</div>
                          if (!nodesList || nodesList.length === 0) return <div style={{ padding: '10px', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)' }}>{t('flow.copyNodeEmpty')}</div>
                          return nodesList.map((node) => {
                            const srcKey = `${proj.id}/${activeWf.id}/${node.nodeId}`
                            const selected = copySelected && copySelected.srcKey === srcKey
                            const ports = node.inputs.reduce((sum, inp) => sum + (inp.outputs?.length || 0), 0)
                            return (
                              <button
                                key={`${node.nodeId}`}
                                onClick={() => setCopySelected({ data: node, srcKey })}
                                onDoubleClick={() => handleCopyNode(node)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                                  padding: '7px 10px', border: 'none', borderBottom: '1px solid var(--border-soft)',
                                  background: selected ? 'color-mix(in oklab, var(--accent), transparent 92%)' : 'transparent',
                                  color: 'var(--fg)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 'calc(13px * var(--font-scale))',
                                }}
                              >
                                <span style={{ width: 10, height: 10, borderRadius: '50%', background: node.color, flexShrink: 0 }} />
                                <span style={{ flex: 1, minWidth: 0 }}>
                                  <span style={{ fontWeight: 500 }}>{node.label}</span>
                                  <span style={{ display: 'block', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {node.key}{node.engine ? ` · ${node.engine}${node.model ? ` / ${node.model}` : ''}` : ''}
                                  </span>
                                </span>
                                <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', flexShrink: 0 }}>{t('flow.portCount', { in: node.inputs.length, out: ports })}</span>
                              </button>
                            )
                          })
                        })()}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={() => setCopyOpen(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={!copySelected} onClick={() => copySelected && handleCopyNode(copySelected.data)}>{t('flow.copyNodeConfirm')}</Button>
            </div>
          </ResizablePanel>
        </div>
      )}

      {/* Export workflow JSON preview */}
      {showJson && (
        <div className="modal-overlay" onClick={() => setShowJson(false)} style={{ zIndex: 400 }}>
          <ResizablePanel className="modal" style={{ width: 600, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{t('flow.jsonConfigTitle')}</span>
              <Button variant="icon" onClick={() => setShowJson(false)}>✕</Button>
            </div>
            <div className="modal-body" style={{ padding: 0 }}>
              <pre style={{ margin: 0, padding: 16, fontFamily: 'var(--font-mono)', fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.6, background: 'var(--surface)', color: 'var(--fg)', overflow: 'auto', maxHeight: '60vh', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {JSON.stringify(buildCanvasJson(), null, 2)}
              </pre>
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={handleCopyJson}>{t('common.copy')}</Button>
              <Button variant="primary" onClick={() => setShowJson(false)}>{t('common.close')}</Button>
            </div>
          </ResizablePanel>
        </div>
      )}

      {/* Import workflow JSON */}
      {!readOnly && showImport && (
        <div className="modal-overlay" onClick={() => setShowImport(false)} style={{ zIndex: 400 }}>
          <ResizablePanel className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{t('flow.importJsonTitle')}</span>
              <Button variant="icon" onClick={() => setShowImport(false)}>✕</Button>
            </div>
            <div className="modal-body">
              <Textarea
                value={importText}
                onChange={(e) => { setImportText(e.target.value); setImportError('') }}
                placeholder={t('flow.importPlaceholder')}
                spellCheck={false}
                style={{ height: 320, fontFamily: 'var(--font-mono)', fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.6, background: 'var(--surface)', resize: 'vertical' }}
              />
              {importError && <p style={{ color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))', marginTop: 8 }}>{importError}</p>}
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={() => setShowImport(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" onClick={handleImport} disabled={!importText.trim()}>{t('flow.confirmImport')}</Button>
            </div>
          </ResizablePanel>
        </div>
      )}

      {/* Delete confirm dialog */}
      <WorkflowExecutionWarningDialog
        warnings={saveWarnings}
        onConfirm={() => { setSaveWarnings([]); void handleSave(true) }}
        onCancel={() => setSaveWarnings([])}
      />
      <ConfirmDialog
        open={!readOnly && confirmDeleteId !== null}
        title={t('flow.deleteStepTitle')}
        message={t('flow.deleteStepMessage')}
        confirmText={t('common.delete')}
        danger
        onConfirm={() => { if (confirmDeleteId) { deleteNode(confirmDeleteId); setConfirmDeleteId(null) } }}
        onCancel={() => setConfirmDeleteId(null)}
      />

      {/* Apply template confirm dialog */}
      {showTemplatePicker && (
        <ConfirmDialog
          open={!readOnly && pendingTemplate !== null}
          title={t('flow.applyTemplateTitle')}
          message={pendingTemplate ? t('flow.applyTemplateMessage', { name: pendingTemplate.name }) : undefined}
          confirmText={t('flow.applyTemplate')}
          danger
          onConfirm={() => { const t = pendingTemplate; setPendingTemplate(null); if (t) void applyTemplate(t) }}
          onCancel={() => setPendingTemplate(null)}
        />
      )}
    </div>
  )
}

export default forwardRef<FlowCanvasHandle, FlowCanvasProps>(
  function FlowCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <FlowCanvasInner {...props} ref={ref} />
      </ReactFlowProvider>
    )
  },
)
