import { useState, useCallback, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import {
  ReactFlow, Controls, Background, addEdge,
  useNodesState, useEdgesState,
  type Node, type Edge, type Connection, type NodeTypes,
  Handle, Position, useReactFlow, ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useProjectStore } from '../stores/projectStore'
import { engineApi, type EngineInfo } from '../api/client'
import { engineLabel } from '../engineMeta'

/* ══════════════════════════════════════════
   Types — matching canvas-editor.html JSON
   ══════════════════════════════════════════ */

interface SubOutput { name: string; type: string }
interface InputField { name: string; type: string; outputs: SubOutput[] }
interface OutputField { name: string; type: string }

interface StepNodeData {
  nodeId: number
  key: string
  label: string
  engine: string
  model: string
  color: string
  prompt: string
  inputs: InputField[]
  outputs: OutputField[]
  [k: string]: unknown
}

function syncOutputs(inputs: InputField[]): OutputField[] {
  return inputs.flatMap((inp) => inp.outputs || [])
}

/* ══════════════════════════════════════════
   Default template (matching user's JSON)
   ══════════════════════════════════════════ */

const DEFAULT_NODES: StepNodeData[] = [
  { nodeId: 1, key: 'req', label: '需求', engine: 'claude', model: '', color: '#0071e3',
    prompt: '根据业务需求和用户调研，产出 PRD 文档和原型图。明确用户场景、功能点、验收标准。',
    inputs: [
      { name: '业务需求', type: '文档', outputs: [{ name: 'PRD 文档', type: 'Markdown' }, { name: '原型图', type: 'Figma' }] },
      { name: '用户调研', type: 'PDF', outputs: [] },
    ],
    outputs: [{ name: 'PRD 文档', type: 'Markdown' }, { name: '原型图', type: 'Figma' }] },
  { nodeId: 2, key: 'ui', label: 'UI 设计', engine: 'claude', model: '', color: '#7c3aed',
    prompt: '根据 PRD 和原型图，设计高保真 UI 界面，产出设计稿和设计规范文档。',
    inputs: [
      { name: 'PRD 文档', type: 'Markdown', outputs: [{ name: 'UI 设计稿', type: 'Figma' }, { name: '设计规范', type: 'PDF' }] },
      { name: '原型图', type: 'Figma', outputs: [] },
    ],
    outputs: [{ name: 'UI 设计稿', type: 'Figma' }, { name: '设计规范', type: 'PDF' }] },
  { nodeId: 3, key: 'frontend', label: '前端开发', engine: 'claude', model: '', color: '#059669',
    prompt: '根据 UI 设计稿和接口文档，开发前端页面，实现状态管理和单元测试。',
    inputs: [
      { name: 'UI 设计稿', type: 'Figma', outputs: [{ name: '前端页面', type: 'React' }, { name: '状态管理', type: 'Zustand' }, { name: '单元测试', type: 'Vitest' }] },
      { name: '接口文档', type: 'JSON', outputs: [] },
      { name: '组件库', type: 'React', outputs: [] },
    ],
    outputs: [{ name: '前端页面', type: 'React' }, { name: '状态管理', type: 'Zustand' }, { name: '单元测试', type: 'Vitest' }] },
  { nodeId: 4, key: 'backend', label: '后端开发', engine: 'codex', model: 'gpt-5.5', color: '#d97706',
    prompt: '根据 PRD 和接口文档，开发后端 API 服务，设计数据库表结构。',
    inputs: [
      { name: 'PRD 文档', type: 'Markdown', outputs: [{ name: 'API 服务', type: 'Go' }, { name: '数据库', type: 'MySQL' }] },
      { name: '接口文档', type: 'JSON', outputs: [] },
    ],
    outputs: [{ name: 'API 服务', type: 'Go' }, { name: '数据库', type: 'MySQL' }] },
  { nodeId: 5, key: 'test', label: '测试', engine: 'codex', model: '', color: '#dc2626',
    prompt: '对前端页面和后端 API 进行集成测试，产出测试报告和 Bug 列表。',
    inputs: [
      { name: '前端页面', type: 'React', outputs: [{ name: '测试报告', type: 'HTML' }, { name: 'Bug 列表', type: 'Excel' }] },
      { name: 'API 服务', type: 'Go', outputs: [] },
    ],
    outputs: [{ name: '测试报告', type: 'HTML' }, { name: 'Bug 列表', type: 'Excel' }] },
  { nodeId: 6, key: 'deploy', label: '上线', engine: 'hermes', model: 'grok-4.3', color: '#16a34a',
    prompt: '根据测试报告和部署文档，将服务部署到生产环境。',
    inputs: [
      { name: '测试报告', type: 'HTML', outputs: [{ name: '生产环境', type: 'K8s' }] },
      { name: '部署文档', type: 'Markdown', outputs: [] },
    ],
    outputs: [{ name: '生产环境', type: 'K8s' }] },
]

interface CanvasConnection { from: number; fromPort: number; to: number; toPort: number; label?: string }

const DEFAULT_CONNECTIONS: CanvasConnection[] = [
  { from: 1, fromPort: 0, to: 2, toPort: 0 },
  { from: 2, fromPort: 0, to: 3, toPort: 0 },
  { from: 2, fromPort: 1, to: 3, toPort: 1 },
  { from: 3, fromPort: 1, to: 4, toPort: 0 },
  { from: 3, fromPort: 2, to: 4, toPort: 1 },
  { from: 3, fromPort: 0, to: 5, toPort: 0 },
  { from: 4, fromPort: 0, to: 5, toPort: 1 },
  { from: 4, fromPort: 1, to: 5, toPort: 1 },
  { from: 5, fromPort: 0, to: 6, toPort: 0 },
]

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
  return conns.map((c, i) => ({
    id: `conn-${i}`,
    source: idMap.get(c.from) || String(c.from),
    sourceHandle: `out-${c.fromPort}`,
    target: idMap.get(c.to) || String(c.to),
    targetHandle: `in-${c.toPort}`,
    style: { stroke: 'var(--accent)', strokeWidth: 2 },
  }))
}

function loadCanvasData(stepsJson: any): { nodes: StepNodeData[]; connections: CanvasConnection[] } {
  // New format: { nodes, connections }
  if (stepsJson?.nodes?.length) {
    const nodes: StepNodeData[] = stepsJson.nodes.map((n: any) => ({
      nodeId: n.id,
      key: n.type || n.key,
      label: n.title || n.label || n.type,
      engine: n.engine || 'claude',
      model: n.model || '',
      color: n.color || '#888888',
      prompt: n.prompt || '',
      position: n.position,
      inputs: (n.inputs || []).map((inp: any) => ({
        name: inp.name || '', type: inp.type || 'any',
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
      color: s.color || '#888888',
      prompt: s.prompt || '',
      inputs: (s.inputs || []).map((inp: any) => ({
        name: inp.name || inp, type: inp.type || 'document',
        outputs: (inp.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || 'any' })),
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
  return { nodes: DEFAULT_NODES, connections: DEFAULT_CONNECTIONS }
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
        <div style={{ width: 24, height: 24, borderRadius: 6, background: `${data.color}20`, color: data.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600 }}>
          {data.label.charAt(0)}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{data.label}</span>
        <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--surface)', color: 'var(--muted)' }}>{data.engine}</span>
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
              <span style={{ fontSize: 10, color: 'var(--meta)', background: 'var(--surface)', padding: '0 3px', borderRadius: 2 }}>{inp.type}</span>
            </div>
            {/* Sub-output rows */}
            {inp.outputs.map((sub, j) => {
              let subTop = labelTop + PORT_ROW_H
              for (let k = 0; k < j; k++) subTop += SUB_ROW_H
              return (
                <div key={`sub-${j}`} style={{ position: 'absolute', top: subTop, left: 28, right: 14, height: SUB_ROW_H, display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--meta)' }}>
                  <span>↳</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub.name}</span>
                  <span style={{ fontSize: 9, background: 'var(--surface)', padding: '0 2px', borderRadius: 2 }}>{sub.type}</span>
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
  fontSize: 12, fontWeight: 600, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8,
}

/* ══════════════════════════════════════════
   Input editor with sub-outputs
   ══════════════════════════════════════════ */
function InputEditor({ inputs, onChange }: { inputs: InputField[]; onChange: (v: InputField[]) => void }) {
  const updateInput = (i: number, field: 'name' | 'type', val: string) => {
    const next = [...inputs]; next[i] = { ...next[i], [field]: val }; onChange(next)
  }
  const addInput = () => onChange([...inputs, { name: '', type: 'any', outputs: [] }])
  const removeInput = (i: number) => onChange(inputs.filter((_, idx) => idx !== i))

  const addSubOutput = (i: number) => {
    const next = [...inputs]
    next[i] = { ...next[i], outputs: [...next[i].outputs, { name: '', type: 'any' }] }
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
              <input value={inp.name} onChange={(e) => updateInput(i, 'name', e.target.value)} placeholder="名称" style={{ flex: 1, height: 28, fontSize: 12 }} />
              <input value={inp.type} onChange={(e) => updateInput(i, 'type', e.target.value)} placeholder="类型" style={{ width: 60, height: 28, fontSize: 12 }} />
              <button className="btn-icon" onClick={() => removeInput(i)} style={{ width: 22, height: 22, color: 'var(--danger)', fontSize: 14 }}>×</button>
            </div>
            {/* Sub-outputs */}
            {inp.outputs.map((sub, j) => (
              <div key={j} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4, marginLeft: 14 }}>
                <span style={{ color: 'var(--meta)', fontSize: 11 }}>↳</span>
                <input value={sub.name} onChange={(e) => updateSubOutput(i, j, 'name', e.target.value)} placeholder="输出名称" style={{ flex: 1, height: 24, fontSize: 11 }} />
                <select value={sub.type} onChange={(e) => updateSubOutput(i, j, 'type', e.target.value)} style={{ width: 72, height: 24, fontSize: 11 }}>
                  <option value="string">字符串</option>
                  <option value="json">JSON</option>
                  <option value="file">文件</option>
                </select>
                <button className="btn-icon" onClick={() => removeSubOutput(i, j)} style={{ width: 20, height: 20, color: 'var(--danger)', fontSize: 12 }}>×</button>
              </div>
            ))}
            <button onClick={() => addSubOutput(i)} style={{ fontSize: 11, color: 'var(--success)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 4, marginLeft: 14, padding: '2px 0' }}>
              + 对应输出
            </button>
          </div>
        ))}
        <button onClick={addInput} style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}>
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

function NodeConfigPanel({ node, unavailableKeys, engines, enginesLoading, enginesError, onValidationChange, onSave, onRequestDelete, onClose }: {
  node: StepNodeData
  unavailableKeys: string[]
  engines: EngineInfo[]
  enginesLoading: boolean
  enginesError: string
  onValidationChange: (error: string) => void
  onSave: (data: StepNodeData) => void
  onRequestDelete: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<StepNodeData>({ ...node, inputs: node.inputs.map((i) => ({ ...i, outputs: [...i.outputs] })) })

  // Sync draft when node changes (e.g. clicking different node)
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

  const installedEngines = engines.filter((engine) => engine.installed)
  const currentEngineInstalled = installedEngines.some(
    (engine) => engine.id === draft.engine
  )

  return (
    <div style={{ width: '50vw', minWidth: 420, maxWidth: '50vw', flexShrink: 0, background: 'var(--bg)', borderLeft: '1px solid var(--border-soft)', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 28, height: 28, borderRadius: 6, background: `${draft.color}20`, color: draft.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}>
            {draft.label.charAt(0)}
          </div>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{draft.label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            className="btn-primary"
            style={{ fontSize: 12, padding: '4px 12px' }}
            disabled={Boolean(keyError)}
            onClick={() => onSave({ ...draft, key: normalizedKey })}
          >
            保存
          </button>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
      </div>

      <div>
        <div style={sectionTitle}>基本信息</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>名称</label>
            <input value={draft.label} onChange={(e) => updateDraft('label', e.target.value)} />
          </div>
          <div>
            <label htmlFor="step-type" style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>
              阶段标识（type）<span style={{ color: 'var(--danger)' }}> *</span>
            </label>
            <input
              id="step-type"
              value={draft.key}
              onChange={(e) => updateDraft('key', e.target.value)}
              required
              aria-invalid={Boolean(keyError)}
              aria-describedby={keyError ? 'step-type-error' : 'step-type-help'}
              style={keyError ? { borderColor: 'var(--danger)' } : undefined}
              placeholder="如 frontend"
            />
            <div
              id={keyError ? 'step-type-error' : 'step-type-help'}
              style={{ marginTop: 4, fontSize: 11, color: keyError ? 'var(--danger)' : 'var(--fg-3)', lineHeight: 1.4 }}
            >
              {keyError || '用于阶段状态和依赖引用，当前流程内必须唯一'}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>提示词</label>
            <textarea value={draft.prompt} onChange={(e) => updateDraft('prompt', e.target.value)}
              rows={6} style={{ minHeight: 120, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5 }} placeholder="描述这个阶段要做什么..." />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>引擎</label>
              <select
                value={draft.engine}
                onChange={(e) => updateDraft('engine', e.target.value)}
                disabled={enginesLoading || installedEngines.length === 0}
                style={{ height: 32 }}
              >
                {!currentEngineInstalled && draft.engine && (
                  <option value={draft.engine} disabled>
                    {engineLabel(draft.engine)}（未安装）
                  </option>
                )}
                {installedEngines.map((engine) => (
                  <option key={engine.id} value={engine.id}>
                    {engineLabel(engine.id)}
                    {engine.mode ? ` · ${engine.mode.toUpperCase()}` : ''}
                  </option>
                ))}
              </select>
              <div style={{
                marginTop: 4, fontSize: 10, lineHeight: 1.4,
                color: enginesError
                  ? 'var(--danger)'
                  : currentEngineInstalled
                    ? 'var(--meta)'
                    : 'var(--warn)',
              }}>
                {enginesLoading
                  ? '正在扫描本机执行引擎…'
                  : enginesError
                    ? `引擎扫描失败：${enginesError}`
                    : currentEngineInstalled
                      ? `已安装 ${installedEngines.length} 个执行引擎`
                      : '当前引擎未安装，请选择已安装引擎'}
              </div>
            </div>
            <div style={{ width: 116 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>颜色</label>
              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  type="color"
                  aria-label="阶段颜色"
                  value={draft.color}
                  onChange={(e) => updateDraft('color', e.target.value)}
                  style={{ height: 32, width: 42, cursor: 'pointer', padding: 2 }}
                />
                <button
                  className="btn-ghost"
                  aria-label="随机颜色"
                  title="随机颜色"
                  onClick={() => updateDraft('color', randomStageColor(draft.color))}
                  style={{ height: 32, flex: 1, padding: '0 7px', fontSize: 11 }}
                >
                  随机
                </button>
              </div>
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>模型（可选）</label>
            <input value={draft.model} onChange={(e) => updateDraft('model', e.target.value)} placeholder="如 gpt-5.5 / 留空用默认" />
          </div>
        </div>
      </div>

      <InputEditor
        inputs={draft.inputs}
        onChange={(inputs) => updateDraft('inputs', inputs)}
      />

      <button onClick={onRequestDelete}
        style={{ fontSize: 13, color: 'var(--danger)', border: '1px solid var(--danger)', background: 'transparent', padding: 8, borderRadius: 'var(--radius-sm)' }}>
        删除此阶段
      </button>
    </div>
  )
}

/* ══════════════════════════════════════════
   Canvas Editor Inner
   ══════════════════════════════════════════ */
function CanvasEditorInner() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { fitView } = useReactFlow()
  const activeProject = useProjectStore((s) => s.activeProject)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const fetchProjects = useProjectStore((s) => s.fetchProjects)

  // Always re-fetch project on mount to get latest steps.json
  useEffect(() => {
    const projectName = searchParams.get('project')
    if (!projectName) return

    const doLoad = async () => {
      await fetchProjects()
      const currentProjects = useProjectStore.getState().projects
      const match = currentProjects.find((p) => p.name === projectName)
      if (match) setActiveProject(match)
    }
    doLoad()
  }, []) // eslint-disable-line -- run once on mount

  const { nodes: canvasNodes, connections: canvasConns } = loadCanvasData(activeProject?.steps)

  const [nodes, setNodes, onNodesChange] = useNodesState(canvasToFlowNodes(canvasNodes))
  const [edges, setEdges, onEdgesChange] = useEdgesState(canvasToFlowEdges(canvasConns, canvasNodes))
  const [selectedNode, setSelectedNode] = useState<StepNodeData | null>(null)
  const [nodeConfigError, setNodeConfigError] = useState('')
  const [showJson, setShowJson] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [availableEngines, setAvailableEngines] = useState<EngineInfo[]>([])
  const [enginesLoading, setEnginesLoading] = useState(true)
  const [enginesError, setEnginesError] = useState('')

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

  // Reload canvas when project steps change (e.g. after re-fetch)
  const stepsKey = JSON.stringify(activeProject?.steps)
  useEffect(() => {
    const { nodes: nn, connections: nc } = loadCanvasData(activeProject?.steps)
    setNodes(canvasToFlowNodes(nn))
    setEdges(canvasToFlowEdges(nc, nn))
    setSelectedNode(null)
    setNodeConfigError('')
    setTimeout(() => fitView({ padding: 0.2 }), 100)
  }, [stepsKey]) // eslint-disable-line

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

  const onConnect = useCallback((params: Connection) => {
    setEdges((eds) => addEdge({ ...params, style: { stroke: 'var(--accent)', strokeWidth: 2 } }, eds))
  }, [setEdges])

  const onEdgeDoubleClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setEdges((eds) => eds.filter((e) => e.id !== edge.id))
  }, [setEdges])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
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
      data: { nodeId, key: `step_${id}`, label: '新阶段', engine: 'claude', model: '', color: randomStageColor(), prompt: '', inputs: [{ name: 'input', type: 'any', outputs: [{ name: 'output', type: 'any' }] }], outputs: [{ name: 'output', type: 'any' }] } as StepNodeData,
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
  const buildCanvasJson = () => {
    const nodesArr = nodes.map((n) => {
      const d = n.data as StepNodeData
      return {
        id: d.nodeId,
        type: d.key,
        title: d.label,
        color: d.color,
        position: n.position,
        engine: d.engine, model: d.model,
        prompt: d.prompt,
        inputs: d.inputs,
        outputs: d.outputs,
      }
    })
    // Build connections from edges
    const idToNum = new Map(nodes.map((n) => [n.id, (n.data as StepNodeData).nodeId]))
    const conns = edges.map((e) => {
      const sourceHandle = e.sourceHandle || 'out-0'
      const targetHandle = e.targetHandle || 'in-0'
      return {
        from: idToNum.get(e.source) || 0,
        fromPort: parseInt(sourceHandle.replace('out-', '')) || 0,
        to: idToNum.get(e.target) || 0,
        toPort: parseInt(targetHandle.replace('in-', '')) || 0,
      }
    })
    return { nodes: nodesArr, connections: conns }
  }

  const [saveMsg, setSaveMsg] = useState('')

  const handleLoadDefault = async () => {
    try {
      const res = await fetch('/api/project/default-steps')
      if (!res.ok) return
      const data = await res.json()
      const { nodes: newNodes, connections: newConns } = loadCanvasData(data)
      setNodes(canvasToFlowNodes(newNodes))
      setEdges(canvasToFlowEdges(newConns, newNodes))
      setSelectedNode(null)
      setTimeout(() => fitView({ padding: 0.2 }), 100)
    } catch (e) {
      console.error('Load default failed:', e)
    }
  }

  const handleSave = async () => {
    if (!activeProject) return
    if (nodeConfigError) {
      setSaveMsg(`保存失败：${nodeConfigError}`)
      setTimeout(() => setSaveMsg(''), 5000)
      return
    }

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
      setSaveMsg(`保存失败：阶段“${missingType.label}”的 type 不能为空`)
      setTimeout(() => setSaveMsg(''), 5000)
      return
    }
    const invalidType = stepTypes.find((step) => !STEP_TYPE_PATTERN.test(step.value))
    if (invalidType) {
      setSaveMsg(`保存失败：阶段“${invalidType.label}”的 type 格式不正确`)
      setTimeout(() => setSaveMsg(''), 5000)
      return
    }
    const seenTypes = new Map<string, string>()
    for (const step of stepTypes) {
      const previousLabel = seenTypes.get(step.value)
      if (previousLabel) {
        setSaveMsg(`保存失败：type “${step.value}” 在“${previousLabel}”和“${step.label}”中重复`)
        setTimeout(() => setSaveMsg(''), 5000)
        return
      }
      seenTypes.set(step.value, step.label)
    }

    try {
      const steps = buildCanvasJson()
      const res = await fetch(`/api/project/save-steps?project_id=${encodeURIComponent(activeProject.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps }),
      })
      if (res.ok) {
        setActiveProject({ ...activeProject, steps })
        setSaveMsg('保存成功')
        setTimeout(() => setSaveMsg(''), 2000)
      } else {
        const error = await res.json().catch(() => null)
        setSaveMsg(`保存失败：${error?.detail || `HTTP ${res.status}`}`)
        setTimeout(() => setSaveMsg(''), 5000)
      }
    } catch (e) {
      console.error('Save failed:', e)
      setSaveMsg(`保存失败：${e instanceof Error ? e.message : '网络错误'}`)
      setTimeout(() => setSaveMsg(''), 5000)
    }
  }

  const handleCopyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(buildCanvasJson(), null, 2))
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
          color: '#fff', fontSize: 13, fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          {saveMsg}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ height: 48, background: 'var(--bg)', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', padding: '0 10px', gap: 8, flexShrink: 0, overflowX: 'auto' }}>
        <button
          className="btn-ghost"
          aria-label="返回任务看板"
          title="返回当前项目的任务看板"
          onClick={() => navigate('/tasks')}
          style={{ height: 30, padding: '0 9px' }}
        >
          ← 看板
        </button>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>流程编辑器</span>
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={handleLoadDefault}>↻ 加载默认</button>
        <button className="btn-ghost" onClick={() => setShowJson(true)}>{'{ }'} JSON</button>
        <button className="btn-ghost" onClick={handleAutoLayout}>⊞ 布局</button>
        <button className="btn-ghost" onClick={handleAddNode}>+ 阶段</button>
        <button className="btn-primary" onClick={handleSave}>保存</button>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1 }}>
          <ReactFlow nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu} onEdgeDoubleClick={onEdgeDoubleClick}
            nodeTypes={nodeTypes} fitView deleteKeyCode={null}
            connectionLineStyle={{ stroke: '#999', strokeWidth: 2, strokeDasharray: '5 5' }}
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
            }}
            onRequestDelete={() => setConfirmDeleteId(String(selectedNode.nodeId))}
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
          <div onClick={() => { const n = nodes.find((nd) => nd.id === contextMenu.nodeId); if (n) setSelectedNode(n.data as StepNodeData); setContextMenu(null) }}
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

      {/* JSON Preview */}
      {showJson && (
        <div className="modal-overlay" onClick={() => setShowJson(false)} style={{ zIndex: 400 }}>
          <div className="modal" style={{ width: 600, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">工作流 JSON 配置</span>
              <button className="btn-icon" onClick={() => setShowJson(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: 0 }}>
              <pre style={{ margin: 0, padding: 16, fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.6, background: 'var(--surface)', color: 'var(--fg)', overflow: 'auto', maxHeight: '60vh', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {JSON.stringify(buildCanvasJson(), null, 2)}
              </pre>
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={handleCopyJson}>复制</button>
              <button className="btn-primary" onClick={() => setShowJson(false)}>关闭</button>
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
    </div>
  )
}

export default function CanvasEditor() {
  return (
    <ReactFlowProvider>
      <CanvasEditorInner />
    </ReactFlowProvider>
  )
}
