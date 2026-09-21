import { useCompactLayout } from '../hooks/useCompactLayout'
import MobileSheet from './MobileSheet'
import FlowBookmark, { BookmarkContext, loadBookmarks, saveBookmarks } from './FlowBookmark'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Input from './Input'
import MarkdownEditor from './MarkdownEditor'
import Combobox from './Combobox'
import Select from './Select'
import EngineSelect from './EngineSelect'
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
  fetchEngineModels,
  fetchTemplates,
  getCachedEngineModels,
  invalidateTemplates,
  projectApi,
  templateApi,
  workflowApi,
  type EngineInfo,
  type EngineModel,
  type Project,
  type TemplateInfo,
  type WorkflowSummary,
} from '../api/client'
import { OUTPUT_TYPES, DEFAULT_OUTPUT_TYPE } from '../config/outputTypes'
import { DEFAULT_EXECUTION_ENGINE, engineLabel } from '../engineMeta'
import { initialStageConfig, normalizeStepConfig } from '../utils/stageConfig'
import { copyText } from '../utils/clipboard'
import StageConfigFields from './StageConfigFields'
import StagePromptVariablesHint from './StagePromptVariablesHint'
import { useI18n } from '../i18n'
import { useEngineRevision } from '../stores/engineAvailabilityStore'

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
   Types — matching canvas-editor.html JSON
   ══════════════════════════════════════════ */

interface SubOutput { name: string; type: string }
interface InputField { name: string; type: string; outputs: SubOutput[] }
interface OutputField { name: string; type: string }
const DEFAULT_MAX_RETURN_ROUNDS = 3
const MAX_CONFIGURED_RETURN_ROUNDS = 20

function normalizeMaxReturnRounds(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return DEFAULT_MAX_RETURN_ROUNDS
  return Math.max(1, Math.min(MAX_CONFIGURED_RETURN_ROUNDS, parsed))
}

interface ReviewConfig {
  mode: 'skip' | 'auto' | 'manual'
  auto: boolean
  maxRetries: number
  engine: string
  model: string
  prompt: string
  config: Record<string, string>
}

const emptyReview = (): ReviewConfig => ({
  mode: 'manual',
  auto: false,
  maxRetries: 1,
  engine: '',
  model: '',
  prompt: '',
  config: {},
})

interface StepNodeData {
  nodeId: number
  key: string
  label: string
  autoStart?: boolean
  engine: string
  model: string
  color: string
  prompt: string
  config: Record<string, string>
  inputs: InputField[]
  outputs: OutputField[]
  maxReturnRounds: number
  review?: ReviewConfig
  kind?: 'llm' | 'task_dispatch'
  dispatch?: {
    targetProjectId: string
    targetWorkflowId: string
    targetStartStepKey: string
    startMode: 'inherit' | 'immediate'
  }
  [k: string]: unknown
}

function syncOutputs(inputs: InputField[]): OutputField[] {
  return inputs.flatMap((inp) => inp.outputs || [])
}

interface CanvasConnection {
  from: number
  fromPort: number
  to: number
  toPort: number
  label?: string
  kind?: 'solid' | 'dashed'
}

/* ══════════════════════════════════════════
   Conversion: canvas JSON ↔ React Flow
   ══════════════════════════════════════════ */

function canvasToFlowNodes(nodesData: StepNodeData[]): Node[] {
  const defaultGapX = 320, startX = 100, y = 100
  return nodesData.map((step, i) => {
    // Use stored position if available, otherwise auto-layout
    const pos = (step as any).position
    return {
      id: String(step.nodeId), type: 'step',
      position: pos || { x: startX + i * defaultGapX, y },
      data: step,
    }
  })
}

function canvasToFlowEdges(conns: CanvasConnection[], nodesData: StepNodeData[]): Edge[] {
  const idMap = new Map(nodesData.map((n) => [n.nodeId, String(n.nodeId)]))
  return conns.map((c, i) => {
    const kind = c.kind === 'dashed' ? 'dashed' : 'solid'
    return {
      id: `conn-${i}`,
      source: idMap.get(c.from) || String(c.from),
      sourceHandle: `out-${c.fromPort}`,
      target: idMap.get(c.to) || String(c.to),
      targetHandle: `in-${c.toPort}`,
      data: { kind },
      style: kind === 'dashed'
        ? { stroke: 'var(--warn)', strokeWidth: 2, strokeDasharray: '8 4' }
        : { stroke: 'var(--accent)', strokeWidth: 2 },
    }
  })
}

function loadCanvasData(stepsJson: any): { nodes: StepNodeData[]; connections: CanvasConnection[] } {
  // Explicitly empty workflow → blank canvas (no default template)
  if (stepsJson && !stepsJson?.nodes?.length && !stepsJson?.steps?.length) {
    return { nodes: [], connections: [] }
  }
  // New format: { nodes, connections }
  if (stepsJson?.nodes?.length) {
    const rawNodes = stepsJson.nodes as any[]
    const usedNodeIds = new Set<number>()
    let nextNodeId = 1
    const nodeIds = rawNodes.map((node) => {
      const rawId = node?.id
      if (Number.isInteger(rawId) && rawId > 0 && !usedNodeIds.has(rawId)) {
        usedNodeIds.add(rawId)
        return rawId
      }
      while (usedNodeIds.has(nextNodeId)) nextNodeId += 1
      const nodeId = nextNodeId
      usedNodeIds.add(nodeId)
      nextNodeId += 1
      return nodeId
    })
    const nodeIdByRawId = new Map(
      rawNodes.map((node, index) => [String(node?.id ?? nodeIds[index]), nodeIds[index]]),
    )
    const normalizeOutput = (output: any): OutputField => ({
      name: typeof output === 'string' ? output : String(output?.name || ''),
      type: typeof output === 'object' && output?.type ? String(output.type) : DEFAULT_OUTPUT_TYPE,
    })
    const nodes: StepNodeData[] = rawNodes.map((n: any, index: number) => {
      const key = String(n.type || n.key || n.id || '')
      return {
        nodeId: nodeIds[index],
        key,
        label: String(n.title || n.label || n.name || key || `Step ${index + 1}`),
        autoStart: Boolean(n.autoStart),
        engine: n.engine === undefined || n.engine === null
          ? ''
          : String(n.engine),
        model: n.model || '',
        color: n.color || 'var(--meta)',
        prompt: n.prompt || '',
        config: normalizeStepConfig(n.config),
        review: { ...(n.review || emptyReview()), config: normalizeStepConfig(n.review?.config) },
        position: n.position,
        inputs: (Array.isArray(n.inputs) ? n.inputs : []).map((inp: any) => ({
          name: typeof inp === 'string' ? inp : String(inp?.name || ''),
          type: typeof inp === 'object' && inp?.type ? String(inp.type) : DEFAULT_OUTPUT_TYPE,
          outputs: (typeof inp === 'object' && Array.isArray(inp?.outputs) ? inp.outputs : []).map(normalizeOutput),
        })),
        outputs: (Array.isArray(n.outputs) ? n.outputs : []).map(normalizeOutput),
        maxReturnRounds: normalizeMaxReturnRounds(n.maxReturnRounds),
        kind: n.kind === 'task_dispatch' ? 'task_dispatch' : 'llm',
        dispatch: n.dispatch,
      }
    })
    const nodeById = new Map(nodes.map((node) => [node.nodeId, node]))
    const rawConnections = Array.isArray(stepsJson.connections)
      ? stepsJson.connections
      : Array.isArray(stepsJson.edges)
        ? stepsJson.edges
        : rawNodes.slice(1).map((_, index) => ({
          from: rawNodes[index]?.id ?? nodeIds[index],
          to: rawNodes[index + 1]?.id ?? nodeIds[index + 1],
        }))
    const connections: CanvasConnection[] = rawConnections
      .map((c: any) => ({
        from: nodeIdByRawId.get(String(c.from)), fromPort: c.fromPort || 0,
        to: nodeIdByRawId.get(String(c.to)), toPort: c.toPort || 0,
        label: c.label || '',
        kind: c.kind === 'dashed' || /dashed|rework/.test(String(c.style || '')) ? 'dashed' : 'solid',
      }))
      .filter((connection: CanvasConnection) => {
        const source = nodeById.get(connection.from)
        const target = nodeById.get(connection.to)
        if (!source || !target) return false
        const sourcePortCount = Math.max(
          1,
          source.inputs.reduce(
            (count, input) => count + (input.outputs?.length || 0),
            0,
          ),
        )
        const targetPortCount = Math.max(1, target.inputs.length)
        return (
          connection.fromPort >= 0 &&
          connection.fromPort < sourcePortCount &&
          connection.toPort >= 0 &&
          connection.toPort < targetPortCount
        )
      })
    return { nodes, connections }
  }
  // Legacy format: { steps }
  if (stepsJson?.steps?.length) {
    const nodes: StepNodeData[] = stepsJson.steps.map((s: any, i: number) => ({
      nodeId: i + 1,
      key: s.key || s.id || '',
      label: s.label || s.name || s.key,
      engine: s.engine === undefined || s.engine === null
        ? ''
        : String(s.engine),
      model: s.model || '',
      color: s.color || 'var(--meta)',
      prompt: s.prompt || '',
      config: normalizeStepConfig(s.config),
      review: { ...(s.review || emptyReview()), config: normalizeStepConfig(s.review?.config) },
      inputs: (s.inputs || []).map((inp: any) => ({
        name: inp.name || inp, type: inp.type || 'document',
        outputs: (inp.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || DEFAULT_OUTPUT_TYPE })),
      })),
      outputs: (s.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || 'markdown' })),
      maxReturnRounds: normalizeMaxReturnRounds(s.maxReturnRounds),
      kind: s.kind === 'task_dispatch' ? 'task_dispatch' : 'llm',
      dispatch: s.dispatch,
    }))
    // Build connections from dependsOn
    const conns: CanvasConnection[] = []
    const keyToId = new Map(nodes.map((n) => [n.key, n.nodeId]))
    for (const s of stepsJson.steps) {
      const key = s.key || s.id
      if (s.dependsOn?.length) {
        for (const dep of s.dependsOn) {
          const fromId = keyToId.get(dep)
          const toId = keyToId.get(key)
          if (fromId && toId) conns.push({ from: fromId, fromPort: 0, to: toId, toPort: 0 })
        }
      }
    }
    return { nodes, connections: conns }
  }
  // No fallback template — the canvas stays blank unless steps are provided
  return { nodes: [], connections: [] }
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
    ? t('flow.newDispatchStage')
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
   Section title style
   ══════════════════════════════════════════ */
const sectionTitle: React.CSSProperties = {
  fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600, color: 'var(--muted)', fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8,
}

/* ══════════════════════════════════════════
   Input editor with sub-outputs
   ══════════════════════════════════════════ */
function InputEditor({ inputs, onChange }: { inputs: InputField[]; onChange: (v: InputField[]) => void }) {
  const { t } = useI18n()
  const updateInput = (i: number, field: 'name' | 'type', val: string) => {
    const next = [...inputs]; next[i] = { ...next[i], [field]: val }; onChange(next)
  }
  const addInput = () => onChange([...inputs, { name: '', type: DEFAULT_OUTPUT_TYPE, outputs: [] }])
  const removeInput = (i: number) => onChange(inputs.filter((_, idx) => idx !== i))

  const addSubOutput = (i: number) => {
    const next = [...inputs]
    next[i] = { ...next[i], outputs: [...next[i].outputs, { name: '', type: DEFAULT_OUTPUT_TYPE }] }
    onChange(next)
  }
  const updateSubOutput = (i: number, j: number, field: 'name' | 'type', val: string) => {
    const next = [...inputs]
    const subs = [...next[i].outputs]; subs[j] = { ...subs[j], [field]: val }
    next[i] = { ...next[i], outputs: subs }; onChange(next)
  }
  const removeSubOutput = (i: number, j: number) => {
    const next = [...inputs]
    next[i] = { ...next[i], outputs: next[i].outputs.filter((_, idx) => idx !== j) }
    onChange(next)
  }

  return (
    <div>
      <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--accent)' }}>●</span> {t('flow.inputArtifacts')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {inputs.map((inp, i) => (
          <div key={i} style={{ background: 'var(--surface)', borderRadius: 6, padding: 8, border: '1px solid var(--border-soft)' }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <Input value={inp.name} onChange={(e) => updateInput(i, 'name', e.target.value)} placeholder={t('flow.name')} style={{ flex: 1, height: 28, fontSize: 'calc(13px * var(--font-scale))' }} />
              <Combobox value={inp.type} options={OUTPUT_TYPES} onChange={(v) => updateInput(i, 'type', v)} placeholder={t('flow.type')} style={{ width: 80, height: 28, fontSize: 'calc(13px * var(--font-scale))', border: '1px solid var(--border)', borderRadius: 4 }} />
              <Button variant="icon" onClick={() => removeInput(i)} style={{ width: 22, height: 22, color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))' }}>×</Button>
            </div>
            {/* Sub-outputs */}
            {inp.outputs.map((sub, j) => (
              <div key={j} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4, marginLeft: 14 }}>
                <span style={{ color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))' }}>↳</span>
                <Input value={sub.name} onChange={(e) => updateSubOutput(i, j, 'name', e.target.value)} placeholder={t('flow.outputName')} style={{ flex: 1, height: 24, fontSize: 'calc(11px * var(--font-scale))' }} />
                <Combobox value={sub.type} options={OUTPUT_TYPES} onChange={(v) => updateSubOutput(i, j, 'type', v)} placeholder={t('flow.type')} style={{ width: 80, height: 24, fontSize: 'calc(11px * var(--font-scale))', border: '1px solid var(--border)', borderRadius: 3 }} />
                <Button variant="icon" onClick={() => removeSubOutput(i, j)} style={{ width: 20, height: 20, color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))' }}>×</Button>
              </div>
            ))}
            <button onClick={() => addSubOutput(i)} style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--success)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 4, marginLeft: 14, padding: '2px 0' }}>
              {t('flow.addSubOutput')}
            </button>
          </div>
        ))}
        <button onClick={addInput} style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}>
          {t('flow.addInput')}
        </button>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════
   Node Config Panel — edits are local until saved
   ══════════════════════════════════════════ */
const STEP_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/
const STAGE_COLOR_PALETTE = [
  '#0071e3', '#7c3aed', '#db2777', '#dc2626',
  '#d97706', '#16a34a', '#059669', '#0891b2',
  '#2563eb', '#4f46e5', '#9333ea', '#c026d3',
]

function randomStageColor(currentColor?: string) {
  const candidates = STAGE_COLOR_PALETTE.filter((color) => color !== currentColor)
  return candidates[Math.floor(Math.random() * candidates.length)]
}

function NodeConfigPanel({ node, unavailableKeys, engines, enginesLoading, enginesError, defaultExecutionEngine, onValidationChange, onDraftChange, onSave, onRequestDelete, onClose, onDirtyChange, projectId }: {
  node: StepNodeData
  unavailableKeys: string[]
  engines: EngineInfo[]
  enginesLoading: boolean
  enginesError: string
  defaultExecutionEngine: string
  onValidationChange: (error: string) => void
  onDraftChange: (data: StepNodeData) => void
  onSave: (data: StepNodeData) => void
  onRequestDelete: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  projectId?: string
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<StepNodeData>({ ...node, inputs: node.inputs.map((i) => ({ ...i, outputs: [...i.outputs] })) })
  const [stageModels, setStageModels] = useState<EngineModel[]>([])
  const [reviewModels, setReviewModels] = useState<EngineModel[]>([])
  const [stageModelsLoading, setStageModelsLoading] = useState(false)
  const [reviewModelsLoading, setReviewModelsLoading] = useState(false)
  const [dispatchProjects, setDispatchProjects] = useState<Project[]>([])
  const [dispatchWorkflows, setDispatchWorkflows] = useState<WorkflowSummary[]>([])
  const [dispatchStages, setDispatchStages] = useState<Array<{ key: string; label: string }>>([])
  const dispatchConfig = draft.dispatch || {
    targetProjectId: '', targetWorkflowId: '', targetStartStepKey: '', startMode: 'inherit' as const,
  }

  // Sync draft when node changes (e.g. clicking different node)

  // Detect dirty state
  useEffect(() => {
    const changed = JSON.stringify(draft) !== JSON.stringify(node)
    onDirtyChange(changed)
    onDraftChange(draft)
  }, [draft, node, onDirtyChange, onDraftChange])
  useEffect(() => {
    setDraft({ ...node, inputs: node.inputs.map((i) => ({ ...i, outputs: [...i.outputs] })) })
  }, [node])

  const updateDraft = (field: string, value: any) => {
    let updated = { ...draft, [field]: value }
    if (field === 'inputs') updated = { ...updated, outputs: syncOutputs(value as InputField[]) }
    setDraft(updated)
  }

  const normalizedKey = (draft.key ?? '').trim()
  const keyError = !normalizedKey
    ? t('flow.keyRequired')
    : !STEP_TYPE_PATTERN.test(normalizedKey)
      ? t('flow.keyPattern')
      : unavailableKeys.includes(normalizedKey)
        ? t('flow.keyDuplicate', { key: normalizedKey })
        : ''

  useEffect(() => {
    onValidationChange(keyError)
  }, [keyError, onValidationChange])

  const selectableEngines = engines.filter(
    (engine) => engine.installed && engine.configured
  )
  const effectiveStageEngine = draft.engine || defaultExecutionEngine
  const currentEngineSelectable = !draft.engine || selectableEngines.some(
    (engine) => engine.id === effectiveStageEngine
  )
  const review: ReviewConfig = draft.review || emptyReview()
  const updateReview = (field: keyof ReviewConfig, value: string | number | boolean | Record<string, string>) => {
    updateDraft('review', { ...review, [field]: value })
  }
  const reviewEngine = review.engine || effectiveStageEngine

  const engineConfigById = (engineId: string) =>
    engines.find((engine) => engine.id === engineId)?.config ?? null
  const stageFields = engineConfigById(draft.engine)?.stage_fields ?? []
  const reviewFields = engineConfigById(reviewEngine)?.stage_fields ?? []
  const updateStageConfig = (key: string, value: string) => {
    const next = { ...(draft.config || {}) }
    if (value === '') delete next[key]
    else next[key] = value
    if (key === 'provider_id') {
      setDraft({ ...draft, config: next, model: '' })
    } else {
      updateDraft('config', next)
    }
  }
  const updateReviewConfig = (key: string, value: string) => {
    const next = { ...(review.config || {}) }
    if (value === '') delete next[key]
    else next[key] = value
    if (key === 'provider_id') {
      updateDraft('review', { ...review, config: next, model: '' })
    } else {
      updateReview('config', next)
    }
  }

  useEffect(() => {
    if (draft.kind !== 'task_dispatch') return
    projectApi.list().then(({ projects }) => setDispatchProjects(projects)).catch(() => setDispatchProjects([]))
  }, [draft.kind])

  useEffect(() => {
    if (draft.kind !== 'task_dispatch' || !dispatchConfig.targetProjectId) {
      setDispatchWorkflows([])
      return
    }
    workflowApi.list(dispatchConfig.targetProjectId)
      .then(({ workflows }) => setDispatchWorkflows(workflows.filter((workflow) => !workflow.deleted)))
      .catch(() => setDispatchWorkflows([]))
  }, [draft.kind, dispatchConfig.targetProjectId])

  useEffect(() => {
    if (draft.kind !== 'task_dispatch' || !dispatchConfig.targetProjectId || !dispatchConfig.targetWorkflowId) {
      setDispatchStages([])
      return
    }
    workflowApi.get(dispatchConfig.targetWorkflowId, dispatchConfig.targetProjectId)
      .then((workflow) => {
        const raw = workflow.steps?.nodes || workflow.steps?.steps || []
        setDispatchStages(raw.map((item: any) => ({
          key: item.key || item.type || item.id,
          label: item.label || item.title || item.type || item.id,
        })).filter((item: any) => item.key))
      })
      .catch(() => setDispatchStages([]))
  }, [draft.kind, dispatchConfig.targetProjectId, dispatchConfig.targetWorkflowId])

  const updateDispatch = (field: string, value: string) => {
    updateDraft('dispatch', { ...dispatchConfig, [field]: value })
  }

  useEffect(() => {
    if (!draft.engine) {
      setStageModels([])
      return
    }
    const providerId = draft.config?.provider_id || ''
    const cached = getCachedEngineModels(draft.engine, providerId)
    if (cached) {
      setStageModels(cached.models || [])
      setStageModelsLoading(false)
      return
    }
    let active = true
    setStageModelsLoading(true)
    fetchEngineModels(draft.engine, false, providerId)
      .then((result) => {
        if (active) setStageModels(result.models || [])
      })
      .catch(() => {
        if (active) setStageModels([])
      })
      .finally(() => {
        if (active) setStageModelsLoading(false)
      })
    return () => { active = false }
  }, [draft.engine, draft.config?.provider_id])

  useEffect(() => {
    if (!reviewEngine) {
      setReviewModels([])
      return
    }
    const providerId = review.config?.provider_id || ''
    const cached = getCachedEngineModels(reviewEngine, providerId)
    if (cached) {
      setReviewModels(cached.models || [])
      setReviewModelsLoading(false)
      return
    }
    let active = true
    setReviewModelsLoading(true)
    fetchEngineModels(reviewEngine, false, providerId)
      .then((result) => {
        if (active) setReviewModels(result.models || [])
      })
      .catch(() => {
        if (active) setReviewModels([])
      })
      .finally(() => {
        if (active) setReviewModelsLoading(false)
      })
    return () => { active = false }
  }, [reviewEngine, review.config?.provider_id])

  if (draft.kind === 'task_dispatch') {
    return (
      <div style={{ width: '50vw', minWidth: 420, maxWidth: '50vw', flexShrink: 0, background: 'var(--bg)', borderLeft: '1px solid var(--border-soft)', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ width: 28, height: 28, borderRadius: 6, background: `${draft.color}20`, color: draft.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{draft.label.charAt(0)}</div><span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{draft.label}</span></div>
          <div style={{ display: 'flex', gap: 6 }}><Button variant="primary" style={{ fontSize: 'calc(13px * var(--font-scale))', padding: '4px 12px' }} disabled={Boolean(keyError) || !dispatchConfig.targetProjectId || !dispatchConfig.targetWorkflowId || !dispatchConfig.targetStartStepKey} onClick={() => onSave({ ...draft, key: normalizedKey })}>{t('flow.stash')}</Button><Button variant="icon" onClick={onClose}>✕</Button></div>
        </div>
        <div><div style={sectionTitle}>{t('flow.basicInfo')}</div><div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}><label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.name')}<Input value={draft.label} onChange={(e) => updateDraft('label', e.target.value)} style={{ marginTop: 4 }} /></label><label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.stageKey')}<Input value={draft.key} onChange={(e) => updateDraft('key', e.target.value)} style={{ marginTop: 4 }} /></label></div></div>
        <div><div style={sectionTitle}>{t('flow.dispatchTarget')}</div><div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.targetProject')}<Select value={dispatchConfig.targetProjectId} onChange={(e) => { updateDraft('dispatch', { ...dispatchConfig, targetProjectId: e.target.value, targetWorkflowId: '', targetStartStepKey: '' }) }} style={{ marginTop: 4 }}><option value="">{t('flow.selectTarget')}</option>{dispatchProjects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.type === 'remote' ? ' · 远程' : ''}</option>)}</Select></label>
          <label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.targetWorkflow')}<Select value={dispatchConfig.targetWorkflowId} onChange={(e) => updateDraft('dispatch', { ...dispatchConfig, targetWorkflowId: e.target.value, targetStartStepKey: '' })} style={{ marginTop: 4 }} disabled={!dispatchConfig.targetProjectId}><option value="">{t('flow.selectTarget')}</option>{dispatchWorkflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</Select></label>
          <label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.targetStartStage')}<Select value={dispatchConfig.targetStartStepKey} onChange={(e) => updateDispatch('targetStartStepKey', e.target.value)} style={{ marginTop: 4 }} disabled={!dispatchConfig.targetWorkflowId}><option value="">{t('flow.selectTarget')}</option>{dispatchStages.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}（{stage.key}）</option>)}</Select></label>
          <label style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('flow.startMode')}<Select value={dispatchConfig.startMode || 'inherit'} onChange={(e) => updateDispatch('startMode', e.target.value)} style={{ marginTop: 4 }}><option value="inherit">{t('flow.inheritAutoStart')}</option><option value="immediate">{t('flow.immediateStart')}</option></Select></label>
        </div></div>
        <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)', lineHeight: 1.5 }}>{t('flow.dispatchTerminalHint')}</div>
      </div>
    )
  }

  return (
    <div style={{ width: '50vw', minWidth: 420, maxWidth: '50vw', flexShrink: 0, background: 'var(--bg)', borderLeft: '1px solid var(--border-soft)', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 28, height: 28, borderRadius: 6, background: `${draft.color}20`, color: draft.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
            {draft.label.charAt(0)}
          </div>
          <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{draft.label}</span>
          <button onClick={onRequestDelete}
            style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)', border: '1px solid var(--danger)', background: 'transparent', padding: '2px 8px', borderRadius: 'var(--radius-sm)', marginLeft: 8 }}>
            {t('common.delete')}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Button
            variant="primary"
            style={{ fontSize: 'calc(13px * var(--font-scale))', padding: '4px 12px' }}
            disabled={Boolean(keyError)}
            onClick={() => onSave({ ...draft, key: normalizedKey })}
          >
            {t('flow.stash')}
          </Button>
          <Button variant="icon" onClick={onClose}>✕</Button>
        </div>
      </div>

      <div>
        <div style={sectionTitle}>{t('flow.basicInfo')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>{t('flow.name')}</label>
              <Input value={draft.label} onChange={(e) => updateDraft('label', e.target.value)} />
            </div>
            <div style={{ width: 116 }}>
              <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>{t('flow.color')}</label>
              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  type="color"
                  aria-label={t('flow.stageColor')}
                  value={draft.color}
                  onChange={(e) => updateDraft('color', e.target.value)}
                  style={{ height: 32, width: 42, cursor: 'pointer', padding: 2 }}
                />
                <Button
                  variant="ghost"
                  aria-label={t('flow.randomColor')}
                  title={t('flow.randomColor')}
                  onClick={() => updateDraft('color', randomStageColor(draft.color))}
                  style={{ height: 32, flex: 1, padding: '0 7px', fontSize: 'calc(11px * var(--font-scale))' }}
                >
                  {t('flow.random')}
                </Button>
              </div>
            </div>
          </div>
          <div>
            <label htmlFor="step-type" style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>
              {t('flow.stageKey')}<span style={{ color: 'var(--danger)' }}> *</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Input
                id="step-type"
                value={draft.key}
                onChange={(e) => updateDraft('key', e.target.value)}
                required
                aria-invalid={Boolean(keyError)}
                aria-describedby={keyError ? 'step-type-error' : 'step-type-help'}
                style={{ flex: 1, ...(keyError ? { borderColor: 'var(--danger)' } : {}) }}
                placeholder="frontend"
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input
                type="checkbox"
                checked={Boolean(draft.autoStart)}
                onChange={(e) => {
                  const updated = { ...draft, autoStart: e.target.checked }
                  setDraft(updated)
                  onSave({ ...updated, key: normalizedKey })
                }}
                style={{ width: 16, height: 16 }}
                />
                {t('flow.autoStart')}
              </label>
            </div>
            <div
              id={keyError ? 'step-type-error' : 'step-type-help'}
              style={{ marginTop: 4, fontSize: 'calc(11px * var(--font-scale))', color: keyError ? 'var(--danger)' : 'var(--fg-3)', lineHeight: 1.4 }}
            >
              {keyError || t('flow.keyHelp')}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>{t('flow.prompt')}</label>
            <MarkdownEditor
              value={draft.prompt}
              onChange={(v) => updateDraft('prompt', v)}
              projectId={projectId}
              minHeight={120}
              placeholder={t('flow.promptPlaceholder')}
              ariaLabel={t('flow.stagePromptAria')}
            />
            <StagePromptVariablesHint />
          </div>
          <InputEditor
            inputs={draft.inputs}
            onChange={(inputs) => updateDraft('inputs', inputs)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>{t('flow.engine')}</label>
              <EngineSelect
                engines={engines}
                value={draft.engine}
                onChange={(engineId) => {
                  setDraft((current) => ({
                    ...current,
                    engine: engineId,
                    model: '',
                    config: engineId
                      ? initialStageConfig(engineConfigById(engineId))
                      : {},
                  }))
                }}
                disabled={enginesLoading}
                defaultOption={{
                  value: '',
                  label: t('flow.defaultExecutionEngineOption', {
                    engine: engineLabel(defaultExecutionEngine, t),
                  }),
                }}
                ariaLabel={t('flow.stageEngineAria')}
                style={{ height: 32 }}
              />
              <div style={{
                marginTop: 4, fontSize: 'calc(11px * var(--font-scale))', lineHeight: 1.4,
                color: enginesError
                  ? 'var(--danger)'
                  : currentEngineSelectable
                    ? 'var(--meta)'
                    : 'var(--warn)',
              }}>
                {enginesLoading
                  ? t('flow.scanningEngines')
                  : enginesError
                    ? t('flow.engineScanFailed', { error: enginesError })
                    : currentEngineSelectable
                      ? t('flow.enginesConfigured', { count: selectableEngines.length })
                      : t('flow.engineUnavailable')}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>{t('flow.modelOptional')}</label>
              <Select
                value={draft.model}
                disabled={!draft.engine || stageModelsLoading}
                onChange={(e) => updateDraft('model', e.target.value)}
                style={{ height: 32 }}
              >
                <option value="">
                  {stageModelsLoading ? t('flow.modelsLoading') : t('flow.engineDefaultModel')}
                </option>
                {draft.model && !stageModels.some((model) => model.id === draft.model) && (
                  <option value={draft.model}>{draft.model}{t('flow.currentConfigSuffix')}</option>
                )}
                {stageModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label || model.id}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {stageFields.length > 0 && (
            <div>
              <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>
                {t('flow.stageConfig')}
              </label>
              <StageConfigFields
                engineId={draft.engine}
                fields={stageFields}
                values={draft.config || {}}
                onChange={(key, value) => updateStageConfig(key, value)}
              />
            </div>
          )}
          <div>
            <div style={sectionTitle}>{t('flow.returnRouting')}</div>
            <label
              htmlFor={`stage-max-return-rounds-${draft.nodeId}`}
              style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}
            >
              {t('flow.maxReturnRounds')}
            </label>
            <Input
              id={`stage-max-return-rounds-${draft.nodeId}`}
              aria-label={t('flow.maxReturnRounds')}
              type="number"
              min={1}
              max={MAX_CONFIGURED_RETURN_ROUNDS}
              step={1}
              value={draft.maxReturnRounds}
              onChange={(event) => updateDraft(
                'maxReturnRounds',
                normalizeMaxReturnRounds(event.target.value),
              )}
              style={{ width: 72, height: 32, fontVariantNumeric: 'tabular-nums' }}
            />
            <div style={{ marginTop: 5, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', lineHeight: 1.5, maxWidth: '68ch' }}>
              {t('flow.maxReturnRoundsHint', {
                default: DEFAULT_MAX_RETURN_ROUNDS,
                max: MAX_CONFIGURED_RETURN_ROUNDS,
              })}
            </div>
          </div>
          <div>
            <div style={sectionTitle}>{t('flow.stageReview')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {([
                    ['skip', t('flow.reviewSkip')],
                    ['auto', t('flow.autoReview')],
                    ['manual', t('flow.manualReview')],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => updateReview('mode', value)}
                      style={{
                        padding: '3px 10px', fontSize: 'calc(12px * var(--font-scale))', borderRadius: 999,
                        border: review.mode === value ? '1px solid var(--accent)' : '1px solid var(--border)',
                        background: review.mode === value ? 'color-mix(in oklab, var(--accent), transparent 88%)' : 'transparent',
                        color: review.mode === value ? 'var(--accent)' : 'var(--fg-2)',
                        cursor: 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {review.mode === 'auto' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'calc(13px * var(--font-scale))' }}>
                    <span style={{ color: 'var(--meta)', whiteSpace: 'nowrap' }}>{t('flow.retry')}</span>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={review.maxRetries}
                      onChange={(e) => updateReview(
                        'maxRetries',
                        Math.max(0, Number.parseInt(e.target.value || '0', 10)),
                      )}
                      style={{ width: 48, height: 24, fontSize: 'calc(13px * var(--font-scale))', padding: '0 6px' }}
                    />
                  </div>
                )}
                {review.mode === 'skip' && (
                  <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>
                    {t('flow.reviewSkipHint')}
                  </div>
                )}
                {review.mode === 'manual' && (
                  <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>
                    {t('flow.reviewPauseHint')}
                  </div>
                )}
              </div>
              {review.mode === 'auto' && (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 'calc(13px * var(--font-scale))', display: 'block', marginBottom: 4 }}>{t('flow.reviewEngine')}</label>
                      <EngineSelect
                        engines={engines}
                        value={review.engine}
                        onChange={(engineId) => {
                          updateDraft('review', {
                            ...review,
                            engine: engineId,
                            model: '',
                            config: initialStageConfig(engineConfigById(engineId || draft.engine)),
                          })
                        }}
                        disabled={enginesLoading}
                        defaultOption={{ value: '', label: t('flow.inheritStageEngine') }}
                        ariaLabel={t('flow.reviewEngine')}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 'calc(13px * var(--font-scale))', display: 'block', marginBottom: 4 }}>{t('flow.reviewModel')}</label>
                      <Select
                        value={review.model}
                        disabled={reviewModelsLoading}
                        onChange={(e) => updateReview('model', e.target.value)}
                      >
                        <option value="">
                          {reviewModelsLoading
                            ? t('flow.modelsLoading')
                            : review.engine
                              ? t('flow.reviewEngineDefaultModel')
                              : t('flow.inheritStageModel')}
                        </option>
                        {review.model && !reviewModels.some((model) => model.id === review.model) && (
                          <option value={review.model}>{review.model}{t('flow.currentConfigSuffix')}</option>
                        )}
                        {reviewModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label || model.id}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                  {reviewFields.length > 0 && (
                    <div>
                      <label style={{ fontSize: 'calc(13px * var(--font-scale))', display: 'block', marginBottom: 4 }}>{t('flow.reviewConfig')}</label>
                      <StageConfigFields
                        engineId={reviewEngine}
                        fields={reviewFields}
                        values={review.config || {}}
                        onChange={(key, value) => updateReviewConfig(key, value)}
                      />
                    </div>
                  )}
                  <div>
                    <label style={{ fontSize: 'calc(13px * var(--font-scale))', display: 'block', marginBottom: 4 }}>{t('flow.reviewPrompt')}</label>
                    <MarkdownEditor
                      value={review.prompt}
                      onChange={(v) => updateReview('prompt', v)}
                      projectId={projectId}
                      minHeight={96}
                      maxHeight={200}
                      placeholder={t('flow.reviewPromptPlaceholder')}
                      ariaLabel={t('flow.reviewPromptAria')}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>


    </div>
  )
}
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
  /** Toolbar slot rendered before the title (e.g. back button). */
  toolbarLeft?: React.ReactNode
  /** Toolbar slot rendered after the dirty indicator (e.g. workflow switcher). */
  toolbarMid?: React.ReactNode
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
  /** Replace the canvas content (marks the canvas dirty). */
  loadSteps: (steps: any) => void
}

function FlowCanvasInner({
  initialSteps,
  onSave,
  onDirtyChange,
  projectId,
  toolbarLeft,
  toolbarMid,
  title,
  saveLabel,
  hint,
  showTemplatePicker = true,
  readOnly: requestedReadOnly = false,
  ref,
}: FlowCanvasProps) {
  const { t } = useI18n()
  const compactLayout = useCompactLayout()
  const readOnly = requestedReadOnly || compactLayout
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
    // engineRevision：设置页改了引擎状态后重新拉取，节点的阶段引擎下拉即时跟随禁用状态。
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
  useEffect(() => {
    if (loadedKey.current === stepsKey) return
    loadedKey.current = stepsKey
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
      data: { nodeId, key: `step_${id}`, label: t('flow.newStage'), kind: 'llm', autoStart: false, engine: '', model: '', color: randomStageColor(), prompt: '', maxReturnRounds: DEFAULT_MAX_RETURN_ROUNDS, review: { mode: 'manual', auto: false, maxRetries: 1, engine: '', model: '', prompt: '' }, inputs: [{ name: 'input', type: DEFAULT_OUTPUT_TYPE, outputs: [{ name: 'output', type: DEFAULT_OUTPUT_TYPE }] }], outputs: [{ name: 'output', type: DEFAULT_OUTPUT_TYPE }] } as StepNodeData,
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
        nodeId, key: `handoff_${id}`, label: t('flow.newDispatchStage'), kind: 'task_dispatch', color: '#eb6c36', engine: '', model: '', prompt: '', maxReturnRounds: DEFAULT_MAX_RETURN_ROUNDS,
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
    const stageNodes = nodes.filter(node => node.type !== 'bookmark')
    const levels: Record<string, number> = {}
    const inDeg: Record<string, number> = {}
    stageNodes.forEach((n) => { inDeg[n.id] = 0 })
    edges.forEach((e) => { inDeg[e.target] = (inDeg[e.target] || 0) + 1 })

    const queue = stageNodes.filter((n) => inDeg[n.id] === 0).map((n) => n.id)
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
    stageNodes.forEach((n) => { if (levels[n.id] === undefined) levels[n.id] = 0 })

    const groups: Record<number, string[]> = {}
    stageNodes.forEach((n) => {
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
    return { nodes: nodesArr, connections: connsArr, bookmarks: saveBookmarks(nds) }
  }
  const buildCanvasJson = () => buildCanvasJsonFromNodes(nodes, edges)

  const computeStepError = (candidateNodes = nodes): string | null => {
    if (nodeConfigError) return t('flow.stageConfigIncomplete', { error: nodeConfigError })
    const stepTypes = candidateNodes.filter(node => node.type !== 'bookmark').map((node, index) => {
      const data = node.data as StepNodeData
      return {
        index,
        label: data.label || t('flow.stageN', { index: index + 1 }),
        value: (data.key ?? '').trim(),
      }
    })
    const missingType = stepTypes.find((step) => !step.value)
    if (missingType) {
      return t('flow.stageTypeRequired', { label: missingType.label })
    }
    const missingDispatch = candidateNodes.find((node) => {
      const data = node.data as StepNodeData
      return data.kind === 'task_dispatch' && (!data.dispatch?.targetProjectId || !data.dispatch.targetWorkflowId || !data.dispatch.targetStartStepKey)
    })
    if (missingDispatch) return t('flow.dispatchConfigRequired')
    const invalidType = stepTypes.find((step) => !STEP_TYPE_PATTERN.test(step.value))
    if (invalidType) {
      return t('flow.stageTypeInvalid', { label: invalidType.label })
    }
    const seenTypes = new Map<string, string>()
    for (const step of stepTypes) {
      const previousLabel = seenTypes.get(step.value)
      if (previousLabel) {
        return t('flow.stageTypeDuplicate', { type: step.value, prev: previousLabel, label: step.label })
      }
      seenTypes.set(step.value, step.label)
    }
    return null
  }

  useImperativeHandle(ref, () => ({
    getSteps: () => buildCanvasJson(),
    validate: () => computeStepError(),
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

  const handleSave = async () => {
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

    try {
      const steps = buildCanvasJsonFromNodes(nodesToSave, edges)
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
          <div><dt>{t('flow.stageKey')}</dt><dd>{previewNode.key}</dd></div>
          <div><dt>{t('flow.autoStart')}</dt><dd>{t(previewNode.autoStart ? 'common.yes' : 'common.no')}</dd></div>
          {previewNode.kind === 'task_dispatch' ? <div><dt>{t('flow.dispatchTarget')}</dt><dd><pre>{JSON.stringify(previewNode.dispatch, null, 2)}</pre></dd></div> : <>
            <div><dt>{t('flow.engine')}</dt><dd>{previewNode.engine || t('settings.defaultExecutionEngine')}</dd></div>
            <div><dt>{t('flow.modelOptional')}</dt><dd>{previewNode.model || t('flow.engineDefaultModel')}</dd></div>
            <div><dt>{t('flow.prompt')}</dt><dd className="mobile-node-prompt">{previewNode.prompt || t('common.none')}</dd></div>
            {Object.keys(previewNode.config || {}).length > 0 && <div><dt>{t('flow.stageConfig')}</dt><dd><pre>{JSON.stringify(previewNode.config, null, 2)}</pre></dd></div>}
            <div><dt>{t('flow.stageReview')}</dt><dd>{t(previewNode.review?.auto ? 'flow.autoReview' : 'flow.manualReview')}</dd></div>
            {previewNode.review?.prompt && <div><dt>{t('flow.reviewPrompt')}</dt><dd className="mobile-node-prompt">{previewNode.review.prompt}</dd></div>}
          </>}
          <div><dt>{t('flow.inputArtifacts')}</dt><dd>{previewNode.inputs?.map(input => input.name).join('、') || t('common.none')}</dd></div>
          <div><dt>{t('flow.outputName')}</dt><dd>{previewNode.outputs?.map(output => output.name).join('、') || t('common.none')}</dd></div>
        </dl>}
      </MobileSheet>
      {/* Toolbar */}
      <div style={{ height: 48, background: 'var(--bg)', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', padding: '0 10px', gap: 8, flexShrink: 0, overflowX: 'auto' }}>
        {toolbarLeft}
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'calc(13px * var(--font-scale))', whiteSpace: 'nowrap' }}>{title ?? t('flow.editorTitle')}</span>
        {toolbarMid}
        <div style={{ flex: 1 }} />
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
        <DropdownMenu label={`${t('flow.addStage')} ▾`}>
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); handleAddNode() }}>{t('flow.addStage')}</MenuItem>
              <MenuItem onClick={() => { close(); handleAddDispatchNode() }}>{t('flow.addDispatchStage')}</MenuItem>
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
          <ReactFlow nodes={nodes} edges={edges}
            onNodesChange={readOnly ? changes => onNodesChange(changes.filter(change => change.type === 'dimensions' || change.type === 'select')) : changes => { onNodesChange(changes); if (changes.some(change => change.type === 'position' || change.type === 'remove' || (change.type === 'dimensions' && Boolean(change.resizing)))) setDirty(true) }} onEdgesChange={readOnly ? undefined : onEdgesChange}
            nodesDraggable={!readOnly} nodesConnectable={!readOnly} edgesReconnectable={!readOnly}
            onNodeClick={readOnly ? (event, node) => { event.stopPropagation(); if (node.type !== 'bookmark') setPreviewNode(node.data as StepNodeData) } : undefined}
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
            {t('flow.editStage')}
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
          <div className="modal" style={{ width: 520, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}

      {/* Copy node from existing workflow — 3-lane swimlane picker: project → workflow → stage */}
      {!readOnly && copyOpen && (
        <div className="modal-overlay" onClick={() => setCopyOpen(false)} style={{ zIndex: 400 }}>
          <div className="modal" style={{ width: 780, height: 'min(66vh, 620px)' }} onClick={(e) => e.stopPropagation()}>
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
                    {/* Lane 3: stages */}
                    <div style={{ flex: 1.2, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface)', overflow: 'hidden' }}>
                      <div style={{ padding: '7px 10px', fontSize: 'calc(12px * var(--font-scale))', fontWeight: 600, color: 'var(--meta)', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)' }}>{t('flow.copyNodeColumnStages')}</div>
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
          </div>
        </div>
      )}

      {/* Export workflow JSON preview */}
      {showJson && (
        <div className="modal-overlay" onClick={() => setShowJson(false)} style={{ zIndex: 400 }}>
          <div className="modal" style={{ width: 600, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}

      {/* Import workflow JSON */}
      {!readOnly && showImport && (
        <div className="modal-overlay" onClick={() => setShowImport(false)} style={{ zIndex: 400 }}>
          <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={!readOnly && confirmDeleteId !== null}
        title={t('flow.deleteStageTitle')}
        message={t('flow.deleteStageMessage')}
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
