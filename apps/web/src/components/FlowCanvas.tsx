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
  templateApi,
  type EngineInfo,
  type EngineModel,
  type TemplateInfo,
} from '../api/client'
import { OUTPUT_TYPES, DEFAULT_OUTPUT_TYPE } from '../config/outputTypes'

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
      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', fontSize: 13, border: 'none', background: 'transparent', color: 'var(--fg)', cursor: 'pointer', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-body)', whiteSpace: 'nowrap' }}
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
interface ReviewConfig {
  auto: boolean
  maxRetries: number
  engine: string
  model: string
  prompt: string
}

interface StepNodeData {
  nodeId: number
  key: string
  label: string
  autoStart?: boolean
  engine: string
  model: string
  color: string
  prompt: string
  inputs: InputField[]
  outputs: OutputField[]
  review?: ReviewConfig
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
    const nodes: StepNodeData[] = stepsJson.nodes.map((n: any) => ({
      nodeId: n.id,
      key: n.type || n.key,
      label: n.title || n.label || n.type,
      autoStart: Boolean(n.autoStart),
      engine: n.engine || 'claude',
      model: n.model || '',
      color: n.color || 'var(--meta)',
      prompt: n.prompt || '',
      review: n.review || { auto: false, maxRetries: 1, engine: '', model: '', prompt: '' },
      position: n.position,
      inputs: (n.inputs || []).map((inp: any) => ({
        name: inp.name || '', type: inp.type || DEFAULT_OUTPUT_TYPE,
        outputs: (inp.outputs || []).map((o: any) => ({ name: o.name, type: o.type })),
      })),
      outputs: (n.outputs || []).map((o: any) => ({ name: o.name, type: o.type })),
    }))
    const nodeById = new Map(nodes.map((node) => [node.nodeId, node]))
    const connections: CanvasConnection[] = (stepsJson.connections || [])
      .map((c: any) => ({
        from: c.from, fromPort: c.fromPort || 0,
        to: c.to, toPort: c.toPort || 0,
        label: c.label || '',
        kind: c.kind === 'dashed' ? 'dashed' : 'solid',
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
      key: s.key || s.id,
      label: s.label || s.name || s.key,
      engine: s.engine || 'claude',
      model: s.model || '',
      color: s.color || 'var(--meta)',
      prompt: s.prompt || '',
      review: s.review || { auto: false, maxRetries: 1, engine: '', model: '', prompt: '' },
      inputs: (s.inputs || []).map((inp: any) => ({
        name: inp.name || inp, type: inp.type || 'document',
        outputs: (inp.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || DEFAULT_OUTPUT_TYPE })),
      })),
      outputs: (s.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || 'markdown' })),
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
const HEADER_H = 44
const PROMPT_H = 28
const PORT_ROW_H = 20
const SUB_ROW_H = 16
const PORT_PAD = 8

function StepNode({ data }: { data: StepNodeData }) {
  const hasPrompt = !!data.prompt
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
      width: 220, height: totalH,
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
      {outputYs.length > 0
        ? outputYs.map((y, i) => (
            <Handle key={`out-${i}`} id={`out-${i}`} type="source" position={Position.Right}
              style={{ ...handleStyle, top: y }} />
          ))
        : <Handle id="out-0" type="source" position={Position.Right} style={{ ...handleStyle, top: '50%' }} />
      }

      {/* Header */}
      <div style={{ height: HEADER_H, padding: '0 12px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 24, height: 24, borderRadius: 6, background: `${data.color}20`, color: data.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}>
          {data.label.charAt(0)}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{data.label}</span>
        <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--surface)', color: 'var(--muted)' }}>{data.engine}</span>
      </div>

      {hasPrompt && (
        <div style={{ height: PROMPT_H, padding: '0 12px', fontSize: 11, color: 'var(--muted)', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {data.prompt.substring(0, 50)}{data.prompt.length > 50 ? '...' : ''}
        </div>
      )}

      {/* Input labels + sub-output labels — absolute positioned */}
      {data.inputs.map((inp, i) => {
        const labelTop = inputYs[i] - PORT_ROW_H / 2
        return (
          <div key={`inp-${i}`}>
            {/* Input row */}
            <div style={{ position: 'absolute', top: labelTop, left: 14, right: 14, height: PORT_ROW_H, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inp.name}</span>
              <span style={{ fontSize: 11, color: 'var(--meta)', background: 'var(--surface)', padding: '0 3px', borderRadius: 2 }}>{inp.type}</span>
            </div>
            {/* Sub-output rows */}
            {inp.outputs.map((sub, j) => {
              let subTop = labelTop + PORT_ROW_H
              for (let k = 0; k < j; k++) subTop += SUB_ROW_H
              return (
                <div key={`sub-${j}`} style={{ position: 'absolute', top: subTop, left: 28, right: 14, height: SUB_ROW_H, display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--meta)' }}>
                  <span>↳</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub.name}</span>
                  <span style={{ fontSize: 11, background: 'var(--surface)', padding: '0 2px', borderRadius: 2 }}>{sub.type}</span>
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

const nodeTypes: NodeTypes = { step: StepNode }

/* ══════════════════════════════════════════
   Section title style
   ══════════════════════════════════════════ */
const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--muted)', fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8,
}

/* ══════════════════════════════════════════
   Input editor with sub-outputs
   ══════════════════════════════════════════ */
function InputEditor({ inputs, onChange }: { inputs: InputField[]; onChange: (v: InputField[]) => void }) {
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
        <span style={{ color: 'var(--accent)' }}>●</span> 输入产物
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {inputs.map((inp, i) => (
          <div key={i} style={{ background: 'var(--surface)', borderRadius: 6, padding: 8, border: '1px solid var(--border-soft)' }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <Input value={inp.name} onChange={(e) => updateInput(i, 'name', e.target.value)} placeholder="名称" style={{ flex: 1, height: 28, fontSize: 13 }} />
              <Combobox value={inp.type} options={OUTPUT_TYPES} onChange={(v) => updateInput(i, 'type', v)} placeholder="类型" style={{ width: 80, height: 28, fontSize: 13, border: '1px solid var(--border)', borderRadius: 4 }} />
              <Button variant="icon" onClick={() => removeInput(i)} style={{ width: 22, height: 22, color: 'var(--danger)', fontSize: 13 }}>×</Button>
            </div>
            {/* Sub-outputs */}
            {inp.outputs.map((sub, j) => (
              <div key={j} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4, marginLeft: 14 }}>
                <span style={{ color: 'var(--meta)', fontSize: 11 }}>↳</span>
                <Input value={sub.name} onChange={(e) => updateSubOutput(i, j, 'name', e.target.value)} placeholder="输出名称" style={{ flex: 1, height: 24, fontSize: 11 }} />
                <Combobox value={sub.type} options={OUTPUT_TYPES} onChange={(v) => updateSubOutput(i, j, 'type', v)} placeholder="类型" style={{ width: 80, height: 24, fontSize: 11, border: '1px solid var(--border)', borderRadius: 3 }} />
                <Button variant="icon" onClick={() => removeSubOutput(i, j)} style={{ width: 20, height: 20, color: 'var(--danger)', fontSize: 13 }}>×</Button>
              </div>
            ))}
            <button onClick={() => addSubOutput(i)} style={{ fontSize: 11, color: 'var(--success)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 4, marginLeft: 14, padding: '2px 0' }}>
              + 对应输出
            </button>
          </div>
        ))}
        <button onClick={addInput} style={{ fontSize: 13, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}>
          + 添加输入
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

function NodeConfigPanel({ node, unavailableKeys, engines, enginesLoading, enginesError, onValidationChange, onSave, onRequestDelete, onClose, onDirtyChange, projectId }: {
  node: StepNodeData
  unavailableKeys: string[]
  engines: EngineInfo[]
  enginesLoading: boolean
  enginesError: string
  onValidationChange: (error: string) => void
  onSave: (data: StepNodeData) => void
  onRequestDelete: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  projectId?: string
}) {
  const [draft, setDraft] = useState<StepNodeData>({ ...node, inputs: node.inputs.map((i) => ({ ...i, outputs: [...i.outputs] })) })
  const [stageModels, setStageModels] = useState<EngineModel[]>([])
  const [reviewModels, setReviewModels] = useState<EngineModel[]>([])
  const [stageModelsLoading, setStageModelsLoading] = useState(false)
  const [reviewModelsLoading, setReviewModelsLoading] = useState(false)

  // Sync draft when node changes (e.g. clicking different node)

  // Detect dirty state
  useEffect(() => {
    const changed = JSON.stringify(draft) !== JSON.stringify(node)
    onDirtyChange(changed)
  }, [draft, node, onDirtyChange])
  useEffect(() => {
    setDraft({ ...node, inputs: node.inputs.map((i) => ({ ...i, outputs: [...i.outputs] })) })
  }, [node])

  const updateDraft = (field: string, value: any) => {
    let updated = { ...draft, [field]: value }
    if (field === 'inputs') updated = { ...updated, outputs: syncOutputs(value as InputField[]) }
    setDraft(updated)
  }

  const normalizedKey = draft.key.trim()
  const keyError = !normalizedKey
    ? '阶段标识不能为空'
    : !STEP_TYPE_PATTERN.test(normalizedKey)
      ? '需以英文字母开头，只能包含字母、数字、下划线或连字符'
      : unavailableKeys.includes(normalizedKey)
        ? `阶段标识 “${normalizedKey}” 已存在`
        : ''

  useEffect(() => {
    onValidationChange(keyError)
  }, [keyError, onValidationChange])

  const selectableEngines = engines.filter(
    (engine) => engine.installed && engine.configured
  )
  const currentEngineSelectable = selectableEngines.some(
    (engine) => engine.id === draft.engine
  )
  const review = draft.review || {
    auto: false, maxRetries: 1, engine: '', model: '', prompt: '',
  }
  const updateReview = (field: keyof ReviewConfig, value: string | number | boolean) => {
    updateDraft('review', { ...review, [field]: value })
  }
  const reviewEngine = review.engine || draft.engine

  useEffect(() => {
    if (!draft.engine) {
      setStageModels([])
      return
    }
    const cached = getCachedEngineModels(draft.engine)
    if (cached) {
      setStageModels(cached.models || [])
      setStageModelsLoading(false)
      return
    }
    let active = true
    setStageModelsLoading(true)
    fetchEngineModels(draft.engine)
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
  }, [draft.engine])

  useEffect(() => {
    if (!reviewEngine) {
      setReviewModels([])
      return
    }
    const cached = getCachedEngineModels(reviewEngine)
    if (cached) {
      setReviewModels(cached.models || [])
      setReviewModelsLoading(false)
      return
    }
    let active = true
    setReviewModelsLoading(true)
    fetchEngineModels(reviewEngine)
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
  }, [reviewEngine])

  return (
    <div style={{ width: '50vw', minWidth: 420, maxWidth: '50vw', flexShrink: 0, background: 'var(--bg)', borderLeft: '1px solid var(--border-soft)', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 28, height: 28, borderRadius: 6, background: `${draft.color}20`, color: draft.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}>
            {draft.label.charAt(0)}
          </div>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{draft.label}</span>
          <button onClick={onRequestDelete}
            style={{ fontSize: 13, color: 'var(--danger)', border: '1px solid var(--danger)', background: 'transparent', padding: '2px 8px', borderRadius: 'var(--radius-sm)', marginLeft: 8 }}>
            删除
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Button
            variant="primary"
            style={{ fontSize: 13, padding: '4px 12px' }}
            disabled={Boolean(keyError)}
            onClick={() => onSave({ ...draft, key: normalizedKey })}
          >
            暂存
          </Button>
          <Button variant="icon" onClick={onClose}>✕</Button>
        </div>
      </div>

      <div>
        <div style={sectionTitle}>基本信息</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>名称</label>
              <Input value={draft.label} onChange={(e) => updateDraft('label', e.target.value)} />
            </div>
            <div style={{ width: 116 }}>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>颜色</label>
              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  type="color"
                  aria-label="阶段颜色"
                  value={draft.color}
                  onChange={(e) => updateDraft('color', e.target.value)}
                  style={{ height: 32, width: 42, cursor: 'pointer', padding: 2 }}
                />
                <Button
                  variant="ghost"
                  aria-label="随机颜色"
                  title="随机颜色"
                  onClick={() => updateDraft('color', randomStageColor(draft.color))}
                  style={{ height: 32, flex: 1, padding: '0 7px', fontSize: 11 }}
                >
                  随机
                </Button>
              </div>
            </div>
          </div>
          <div>
            <label htmlFor="step-type" style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>
              阶段标识（type）<span style={{ color: 'var(--danger)' }}> *</span>
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
                placeholder="如 frontend"
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
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
                创建后自动开始
              </label>
            </div>
            <div
              id={keyError ? 'step-type-error' : 'step-type-help'}
              style={{ marginTop: 4, fontSize: 11, color: keyError ? 'var(--danger)' : 'var(--fg-3)', lineHeight: 1.4 }}
            >
              {keyError || '用于阶段状态和依赖引用，当前流程内必须唯一'}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>提示词</label>
            <MarkdownEditor
              value={draft.prompt}
              onChange={(v) => updateDraft('prompt', v)}
              projectId={projectId}
              minHeight={120}
              placeholder="描述这个阶段要做什么..."
              ariaLabel="阶段提示词"
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>引擎</label>
              <EngineSelect
                engines={engines}
                value={draft.engine}
                onChange={(engineId) => {
                  updateDraft('engine', engineId)
                  setDraft((current) => ({ ...current, engine: engineId, model: '' }))
                }}
                disabled={enginesLoading}
                ariaLabel="阶段引擎"
                style={{ height: 32 }}
              />
              <div style={{
                marginTop: 4, fontSize: 11, lineHeight: 1.4,
                color: enginesError
                  ? 'var(--danger)'
                  : currentEngineSelectable
                    ? 'var(--meta)'
                    : 'var(--warn)',
              }}>
                {enginesLoading
                  ? '正在扫描本机执行引擎…'
                  : enginesError
                    ? `引擎扫描失败：${enginesError}`
                    : currentEngineSelectable
                      ? `已配置 ${selectableEngines.length} 个执行引擎`
                      : '当前引擎不可用，请安装或在设置中完成配置'}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>模型（可选）</label>
              <Select
                value={draft.model}
                disabled={stageModelsLoading}
                onChange={(e) => updateDraft('model', e.target.value)}
                style={{ height: 32 }}
              >
                <option value="">
                  {stageModelsLoading ? '模型加载中…' : '使用引擎默认模型'}
                </option>
                {draft.model && !stageModels.some((model) => model.id === draft.model) && (
                  <option value={draft.model}>{draft.model}（当前配置）</option>
                )}
                {stageModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label || model.id}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div style={sectionTitle}>阶段审核</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={review.auto}
                onChange={(e) => updateReview('auto', e.target.checked)}
                style={{ width: 16, height: 16 }}
              />
              自动审核
            </label>
            {review.auto && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                <span style={{ color: 'var(--meta)', whiteSpace: 'nowrap' }}>重试</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={review.maxRetries}
                  onChange={(e) => updateReview(
                    'maxRetries',
                    Math.max(0, Number.parseInt(e.target.value || '0', 10)),
                  )}
                  style={{ width: 48, height: 24, fontSize: 13, padding: '0 6px' }}
                />
              </div>
            )}
          </div>
          {!review.auto && (
            <div style={{ fontSize: 11, color: 'var(--meta)' }}>
              阶段完成后将暂停，等待用户确认进入下一阶段。
            </div>
          )}
          {review.auto && (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>审核引擎</label>
                  <EngineSelect
                    engines={engines}
                    value={review.engine}
                    onChange={(engineId) => {
                      updateDraft('review', {
                        ...review,
                        engine: engineId,
                        model: '',
                      })
                    }}
                    disabled={enginesLoading}
                    defaultOption={{ value: '', label: '继承阶段引擎' }}
                    ariaLabel="审核引擎"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>审核模型</label>
                  <Select
                    value={review.model}
                    disabled={reviewModelsLoading}
                    onChange={(e) => updateReview('model', e.target.value)}
                  >
                    <option value="">
                      {reviewModelsLoading
                        ? '模型加载中…'
                        : review.engine
                          ? '使用审核引擎默认模型'
                          : '继承阶段模型'}
                    </option>
                    {review.model && !reviewModels.some((model) => model.id === review.model) && (
                      <option value={review.model}>{review.model}（当前配置）</option>
                    )}
                    {reviewModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label || model.id}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <div>
                <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>审核要求</label>
                <MarkdownEditor
                  value={review.prompt}
                  onChange={(v) => updateReview('prompt', v)}
                  projectId={projectId}
                  minHeight={96}
                  maxHeight={200}
                  placeholder="描述审核标准、必需产物和验收条件…"
                  ariaLabel="审核要求"
                />
              </div>
            </>
          )}
        </div>
      </div>

      <InputEditor
        inputs={draft.inputs}
        onChange={(inputs) => updateDraft('inputs', inputs)}
      />

    </div>
  )
}
/* ══════════════════════════════════════════
   Flow Canvas component
   ══════════════════════════════════════════ */

export interface FlowCanvasProps {
  /** Canvas JSON ({ nodes, connections } or legacy { steps }). */
  initialSteps?: any
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
  title = '流程编辑器',
  saveLabel = '保存',
  hint = '实线=数据流 · 虚线=返工反馈（连回上游自动变虚线）',
  showTemplatePicker = true,
  ref,
}: FlowCanvasProps) {
  const { fitView } = useReactFlow()
  const initial = loadCanvasData(initialSteps)
  const [nodes, setNodes, onNodesChange] = useNodesState(canvasToFlowNodes(initial.nodes))
  const [edges, setEdges, onEdgesChange] = useEdgesState(canvasToFlowEdges(initial.connections, initial.nodes))
  const [selectedNode, setSelectedNode] = useState<StepNodeData | null>(null)
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
  const [availableEngines, setAvailableEngines] = useState<EngineInfo[]>([])
  const [defaultExecutionEngine, setDefaultExecutionEngine] = useState('claude')
  const [enginesLoading, setEnginesLoading] = useState(true)
  const [enginesError, setEnginesError] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
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
        setEnginesError(error instanceof Error ? error.message : '未知错误')
      })
      .finally(() => setEnginesLoading(false))
  }, [])

  useEffect(() => {
    engineApi.executionConfig()
      .then((config) => setDefaultExecutionEngine(config.resolved_engine || 'claude'))
      .catch(() => setDefaultExecutionEngine('claude'))
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
    setNodes(canvasToFlowNodes(nn))
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
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        setNodes((nds) => nds.filter((n) => !n.selected))
        setEdges((eds) => eds.filter((ed) => !ed.selected))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setNodes, setEdges])

  const onEdgeDoubleClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setEdges((eds) => eds.filter((e) => e.id !== edge.id))
  }, [setEdges])

  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node.data as StepNodeData)
    setContextMenu(null)
  }, [])

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault()
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
      data: { nodeId, key: `step_${id}`, label: '新阶段', autoStart: false, engine: defaultExecutionEngine, model: '', color: randomStageColor(), prompt: '', review: { auto: false, maxRetries: 1, engine: '', model: '', prompt: '' }, inputs: [{ name: 'input', type: DEFAULT_OUTPUT_TYPE, outputs: [{ name: 'output', type: DEFAULT_OUTPUT_TYPE }] }], outputs: [{ name: 'output', type: DEFAULT_OUTPUT_TYPE }] } as StepNodeData,
    }
    setNodes((nds) => [...nds, newNode])
  }

  const handleAutoLayout = useCallback(() => {
    const levels: Record<string, number> = {}
    const inDeg: Record<string, number> = {}
    nodes.forEach((n) => { inDeg[n.id] = 0 })
    edges.forEach((e) => { inDeg[e.target] = (inDeg[e.target] || 0) + 1 })

    const queue = nodes.filter((n) => inDeg[n.id] === 0).map((n) => n.id)
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
    nodes.forEach((n) => { if (levels[n.id] === undefined) levels[n.id] = 0 })

    const groups: Record<number, string[]> = {}
    nodes.forEach((n) => {
      const l = levels[n.id]
      if (!groups[l]) groups[l] = []
      groups[l].push(n.id)
    })

    setNodes((nds) => nds.map((n) => ({
      ...n,
      position: { x: 100 + (levels[n.id] || 0) * 320, y: 100 + (groups[levels[n.id] || 0]?.indexOf(n.id) || 0) * 180 },
    })))
    setTimeout(() => fitView({ padding: 0.2 }), 100)
  }, [nodes, edges, setNodes, fitView])

  // Build canvas-editor JSON for save/preview
  const buildCanvasJsonFromNodes = (nds: typeof nodes, conns: typeof edges) => {
    const idToNum = new Map(nds.map((n) => [n.id, (n.data as StepNodeData).nodeId]))
    const nodesArr = nds.map((n) => {
      const d = n.data as StepNodeData
      return {
        id: d.nodeId, type: d.key, title: d.label, color: d.color,
        autoStart: Boolean(d.autoStart),
        position: n.position, engine: d.engine, model: d.model,
        prompt: d.prompt,
        review: d.review || { auto: false, maxRetries: 1, engine: '', model: '', prompt: '' },
        inputs: d.inputs, outputs: d.outputs,
      }
    })
    const connsArr = conns.map((e) => {
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
    return { nodes: nodesArr, connections: connsArr }
  }
  const buildCanvasJson = () => buildCanvasJsonFromNodes(nodes, edges)

  const computeStepError = (): string | null => {
    if (nodeConfigError) return `阶段配置不完整：${nodeConfigError}`
    const stepTypes = nodes.map((node, index) => {
      const data = node.data as StepNodeData
      return {
        index,
        label: data.label || `阶段 ${index + 1}`,
        value: data.key.trim(),
      }
    })
    const missingType = stepTypes.find((step) => !step.value)
    if (missingType) {
      return `阶段“${missingType.label}”的 type 不能为空`
    }
    const invalidType = stepTypes.find((step) => !STEP_TYPE_PATTERN.test(step.value))
    if (invalidType) {
      return `阶段“${invalidType.label}”的 type 格式不正确`
    }
    const seenTypes = new Map<string, string>()
    for (const step of stepTypes) {
      const previousLabel = seenTypes.get(step.value)
      if (previousLabel) {
        return `type “${step.value}” 在“${previousLabel}”和“${step.label}”中重复`
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
      setNodes(canvasToFlowNodes(nn))
      setEdges(canvasToFlowEdges(nc, nn))
      setSelectedNode(null)
      setNodeConfigError('')
      setDirty(true)
      setTimeout(() => fitView({ padding: 0.2 }), 100)
    },
  }), [nodes, edges, nodeConfigError, ref]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyTemplate = async (t: TemplateInfo) => {
    try {
      const full = await templateApi.get(t.id)
      const { nodes: tNodes, connections: tConns } = loadCanvasData(full.steps ?? full)
      setNodes(canvasToFlowNodes(tNodes))
      setEdges(canvasToFlowEdges(tConns, tNodes))
      setSelectedNode(null)
      setNodeConfigError('')
      setDirty(true)
      setTimeout(() => fitView({ padding: 0.2 }), 100)
    } catch (e) {
      setSaveMsg(`模板加载失败：${e instanceof Error ? e.message : '网络错误'}`)
      setTimeout(() => setSaveMsg(''), 5000)
    }
  }

  const saveCurrentAsTemplate = async () => {
    const name = templateName.trim()
    if (!name) {
      setSaveMsg('保存失败：请填写模板名称')
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
      setSaveMsg(`模板「${name}」保存成功`)
      setTimeout(() => setSaveMsg(''), 5000)
    } catch (e) {
      setSaveMsg(`保存失败：${e instanceof Error ? e.message : '网络错误'}`)
      setTimeout(() => setSaveMsg(''), 5000)
    }
  }

  const onConnect = useCallback((params: Connection) => {
    const { source, target } = params
    if (!source || !target || source === target) return  // self-loop is invalid
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
  }, [setEdges, setDirty])

  const handleSave = async () => {
    const stepError = computeStepError()
    if (stepError) {
      setSaveMsg(`保存失败：${stepError}`)
      setTimeout(() => setSaveMsg(''), 5000)
      return
    }

    try {
      const steps = buildCanvasJson()
      await onSave(steps)
      setDirty(false)
      setSaveMsg('保存成功')
      setTimeout(() => setSaveMsg(''), 2000)
    } catch (e) {
      console.error('Save failed:', e)
      setSaveMsg(`保存失败：${e instanceof Error ? e.message : '网络错误'}`)
      setTimeout(() => setSaveMsg(''), 5000)
    }
  }

  const handleExportJson = () => {
    const text = JSON.stringify(buildCanvasJson(), null, 2)
    setShowJson(true)
    navigator.clipboard.writeText(text)
      .then(() => setSaveMsg('复制成功，JSON 已复制到剪贴板'))
      .catch(() => setSaveMsg('复制失败，请点击弹窗内的「复制」按钮'))
    setTimeout(() => setSaveMsg(''), 3000)
  }

  const handleCopyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(buildCanvasJson(), null, 2))
      .then(() => setSaveMsg('复制成功，JSON 已复制到剪贴板'))
      .catch(() => setSaveMsg('复制失败，请重试'))
    setTimeout(() => setSaveMsg(''), 3000)
  }

  const handleImport = () => {
    try {
      const parsed = JSON.parse(importText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON 必须是对象，包含 nodes 或 steps 字段')
      }
      const { nodes: impNodes, connections: impConns } = loadCanvasData(parsed)
      setNodes(canvasToFlowNodes(impNodes))
      setEdges(canvasToFlowEdges(impConns, impNodes))
      setSelectedNode(null)
      setNodeConfigError('')
      setDirty(true)
      setShowImport(false)
      setImportText('')
      setImportError('')
      setTimeout(() => fitView({ padding: 0.2 }), 100)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'JSON 解析失败，请检查格式')
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
          background: saveMsg.includes('成功') ? 'var(--success)' : 'var(--danger)',
          color: 'var(--accent-fg)', fontSize: 13, fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          {saveMsg}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ height: 48, background: 'var(--bg)', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', padding: '0 10px', gap: 8, flexShrink: 0, overflowX: 'auto' }}>
        {toolbarLeft}
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>{title}</span>
        {toolbarMid}
        <div style={{ flex: 1 }} />
        {dirty && <span style={{ color: 'var(--warn-text)', fontSize: 11, marginLeft: 12 }}>⚠ 有未保存的更改，请点击「保存」持久化</span>}
         {hint && <span style={{ fontSize: 13, color: 'var(--meta)', marginRight: 10 }}>{hint}</span>}
        {showTemplatePicker && <Button variant="ghost" onClick={() => { setShowTemplateModal(true); setTemplateSearch('') }}>流程模板</Button>}
        <DropdownMenu label="JSON ▾">
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); handleExportJson() }}>⬇ 导出 JSON</MenuItem>
              <MenuItem onClick={() => { close(); setImportText(''); setImportError(''); setShowImport(true) }}>⬆ 导入 JSON</MenuItem>
            </>
          )}
        </DropdownMenu>
        <Button variant="ghost" onClick={handleAutoLayout}>⊞ 布局</Button>
        <Button variant="ghost" onClick={handleAddNode}>+ 阶段</Button>
        <Button variant="primary" onClick={() => void handleSave()} style={dirty ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}>{saveLabel}</Button>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1 }} onClick={() => { if (selectedNode && !nodeConfigDirty) { setNodeConfigError(""); setSelectedNode(null); setNodeConfigDirty(false); } } }>
          <ReactFlow nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} onNodeDoubleClick={onNodeDoubleClick}
            onNodeContextMenu={onNodeContextMenu} onEdgeDoubleClick={onEdgeDoubleClick}
            nodeTypes={nodeTypes} fitView deleteKeyCode={null}
            connectionLineStyle={{ stroke: 'var(--meta)', strokeWidth: 2, strokeDasharray: '5 5' }}
            style={{ background: 'var(--surface)' }}>
            <Controls position="top-right" /><Background gap={20} size={1} color="var(--border)" />
          </ReactFlow>
        </div>

        {/* Config panel */}
        {selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            engines={availableEngines}
            enginesLoading={enginesLoading}
            enginesError={enginesError}
            unavailableKeys={nodes
              .map((node) => node.data as StepNodeData)
              .filter((node) => node.nodeId !== selectedNode.nodeId)
              .map((node) => node.key)}
            onValidationChange={setNodeConfigError}
            onSave={(data) => {
              setNodes((nds) => nds.map((n) =>
                n.id === String(data.nodeId) ? { ...n, data } : n
              ))
              setSelectedNode(data)
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
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-raised)', padding: '4px 0', zIndex: 500, minWidth: 140 }}>
          <div onClick={() => { const n = nodes.find((nd) => nd.id === contextMenu.nodeId); if (n) { setSelectedNode(n.data as StepNodeData); setNodeConfigDirty(false); } setContextMenu(null) }}
            style={{ padding: '8px 16px', fontSize: 13, cursor: 'pointer' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
            ✏️ 编辑阶段
          </div>
          <div onClick={() => { setConfirmDeleteId(contextMenu.nodeId); setContextMenu(null) }}
            style={{ padding: '8px 16px', fontSize: 13, cursor: 'pointer', color: 'var(--danger)' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
            🗑 删除
          </div>
        </div>
      )}

      {/* Template list modal */}
      {showTemplatePicker && showTemplateModal && (
        <div className="modal-overlay" onClick={() => setShowTemplateModal(false)} style={{ zIndex: 400 }}>
          <div className="modal" style={{ width: 520, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">流程模板</span>
              <Button variant="icon" onClick={() => setShowTemplateModal(false)}>✕</Button>
            </div>
            <div className="modal-body" style={{ padding: '8px 16px 16px', overflowY: 'auto' }}>
              <Input
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                placeholder="搜索模板名称、描述或 id…"
                spellCheck={false}
                style={{ marginBottom: 10 }}
              />
              {showTemplateSave && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 10, background: 'var(--surface)' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>保存当前画布为流程模板</div>
                  <Input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="模板名称（必填）"
                    spellCheck={false}
                  />
                  <Input
                    value={templateDesc}
                    onChange={(e) => setTemplateDesc(e.target.value)}
                    placeholder="模板描述（可选）"
                    spellCheck={false}
                    style={{ marginTop: 8 }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <Button variant="primary" onClick={() => void saveCurrentAsTemplate()} disabled={!templateName.trim()}>保存模板</Button>
                    <Button variant="ghost" onClick={() => setShowTemplateSave(false)}>取消</Button>
                  </div>
                </div>
              )}
              {templates.length === 0 && (
                <div style={{ padding: '12px 4px', fontSize: 13, color: 'var(--meta)' }}>暂无模板</div>
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
                  return <div style={{ padding: '12px 4px', fontSize: 13, color: 'var(--meta)' }}>无匹配模板</div>
                }
                return filtered.map((t) => (
                <button
                  key={t.id}
                  onClick={() => { setShowTemplateModal(false); setPendingTemplate(t) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 6, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface)', color: 'var(--fg)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13 }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 500 }}>{t.name}</span>
                    {t.description && (
                      <span style={{ display: 'block', fontSize: 13, color: 'var(--meta)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</span>
                    )}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--meta)', flexShrink: 0 }}>{t.nodeCount}步</span>
                </button>
                ))
              })()}
            </div>
            <div className="modal-footer">
              <Button variant="primary" onClick={() => setShowTemplateSave(true)}>保存当前为流程模板</Button>
              <Button variant="ghost" onClick={() => setShowTemplateModal(false)}>取消</Button>
            </div>
          </div>
        </div>
      )}

      {/* Export workflow JSON preview */}
      {showJson && (
        <div className="modal-overlay" onClick={() => setShowJson(false)} style={{ zIndex: 400 }}>
          <div className="modal" style={{ width: 600, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">工作流 JSON 配置</span>
              <Button variant="icon" onClick={() => setShowJson(false)}>✕</Button>
            </div>
            <div className="modal-body" style={{ padding: 0 }}>
              <pre style={{ margin: 0, padding: 16, fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.6, background: 'var(--surface)', color: 'var(--fg)', overflow: 'auto', maxHeight: '60vh', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {JSON.stringify(buildCanvasJson(), null, 2)}
              </pre>
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={handleCopyJson}>复制</Button>
              <Button variant="primary" onClick={() => setShowJson(false)}>关闭</Button>
            </div>
          </div>
        </div>
      )}

      {/* Import workflow JSON */}
      {showImport && (
        <div className="modal-overlay" onClick={() => setShowImport(false)} style={{ zIndex: 400 }}>
          <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">导入工作流 JSON</span>
              <Button variant="icon" onClick={() => setShowImport(false)}>✕</Button>
            </div>
            <div className="modal-body">
              <Textarea
                value={importText}
                onChange={(e) => { setImportText(e.target.value); setImportError('') }}
                placeholder={'粘贴工作流 JSON，例如：\n{"nodes": [{ "id": 1, "type": "req", "title": "需求", ... }], "connections": []}'}
                spellCheck={false}
                style={{ height: 320, fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.6, background: 'var(--surface)', resize: 'vertical' }}
              />
              {importError && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{importError}</p>}
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={() => setShowImport(false)}>取消</Button>
              <Button variant="primary" onClick={handleImport} disabled={!importText.trim()}>确认导入</Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="删除阶段"
        message="确定删除此阶段？相关连线也会被移除。"
        confirmText="删除"
        danger
        onConfirm={() => { if (confirmDeleteId) { deleteNode(confirmDeleteId); setConfirmDeleteId(null) } }}
        onCancel={() => setConfirmDeleteId(null)}
      />

      {/* Apply template confirm dialog */}
      {showTemplatePicker && (
        <ConfirmDialog
          open={pendingTemplate !== null}
          title="应用流程模板"
          message={pendingTemplate ? `应用模板「${pendingTemplate.name}」将替换当前画布上的所有阶段和连线，未保存的更改会丢失。确定继续？` : undefined}
          confirmText="应用模板"
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
