import { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ReactFlow,
  Controls,
  Background,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  Handle,
  Position,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useProjectStore } from '../stores/projectStore'

/* ── Types ── */
interface IOField {
  name: string
  type: string
}

interface StepNodeData {
  key: string
  label: string
  engine: string
  model: string
  color: string
  prompt: string
  inputs: IOField[]
  outputs: IOField[]
  [key: string]: unknown
}

/* ── Step Node ── */
function StepNode({ data }: { data: StepNodeData }) {
  return (
    <div style={{
      width: 220, background: 'var(--bg)',
      border: `1.5px solid ${data.color || 'var(--border)'}`,
      borderRadius: 'var(--radius-md)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
      fontFamily: 'var(--font-body)',
    }}>
      <Handle type="target" position={Position.Left} style={{
        width: 10, height: 10, background: 'var(--bg)', border: '2px solid var(--border)',
      }} />
      <div style={{
        padding: '10px 12px', borderBottom: '1px solid var(--border-soft)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{
          width: 24, height: 24, borderRadius: 6,
          background: `${data.color}20`, color: data.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 600,
        }}>
          {data.label.charAt(0)}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{data.label}</span>
        <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--surface)', color: 'var(--muted)' }}>
          {data.engine}
        </span>
      </div>
      {data.prompt && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--muted)', borderBottom: '1px solid var(--border-soft)' }}>
          {data.prompt.substring(0, 50)}{data.prompt.length > 50 ? '...' : ''}
        </div>
      )}
      <div style={{ padding: '8px 12px' }}>
        {data.inputs.length > 0 && (
          <div style={{ marginBottom: 4 }}>
            {data.inputs.map((inp, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
                <span>{inp.name}</span>
                <span style={{ fontSize: 10, color: 'var(--meta)', background: 'var(--surface)', padding: '0 3px', borderRadius: 2 }}>{inp.type}</span>
              </div>
            ))}
          </div>
        )}
        {data.outputs.length > 0 && (
          <div>
            {data.outputs.map((out, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)', marginBottom: 2, justifyContent: 'flex-end' }}>
                <span>{out.name}</span>
                <span style={{ fontSize: 10, color: 'var(--meta)', background: 'var(--surface)', padding: '0 3px', borderRadius: 2 }}>{out.type}</span>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} />
              </div>
            ))}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{
        width: 10, height: 10, background: 'var(--bg)', border: '2px solid var(--border)',
      }} />
    </div>
  )
}

const nodeTypes: NodeTypes = { step: StepNode }

/* ── Default template ── */
const DEFAULT_STEPS: StepNodeData[] = [
  { key: 'req', label: '需求', engine: 'claude', model: '', color: '#0071e3', prompt: '', inputs: [{ name: '业务需求', type: '文档' }], outputs: [{ name: 'PRD 文档', type: 'Markdown' }] },
  { key: 'ui', label: 'UI 设计', engine: 'claude', model: '', color: '#7c3aed', prompt: '', inputs: [{ name: 'PRD 文档', type: 'Markdown' }], outputs: [{ name: 'UI 设计稿', type: 'Figma' }] },
  { key: 'frontend', label: '前端开发', engine: 'claude', model: '', color: '#059669', prompt: '', inputs: [{ name: 'UI 设计稿', type: 'Figma' }], outputs: [{ name: '前端代码', type: 'React' }] },
  { key: 'backend', label: '后端开发', engine: 'codex', model: 'gpt-5.5', color: '#d97706', prompt: '', inputs: [{ name: 'PRD 文档', type: 'Markdown' }], outputs: [{ name: 'API 服务', type: 'Go' }] },
  { key: 'test', label: '测试', engine: 'codex', model: '', color: '#dc2626', prompt: '', inputs: [{ name: '前端代码', type: 'React' }, { name: 'API 服务', type: 'Go' }], outputs: [{ name: '测试报告', type: 'HTML' }] },
  { key: 'deploy', label: '上线', engine: 'hermes', model: 'grok-4.3', color: '#16a34a', prompt: '', inputs: [{ name: '测试报告', type: 'HTML' }], outputs: [{ name: '部署完成', type: 'K8s' }] },
]

const DEFAULT_DEPS: Record<string, string[]> = {
  ui: ['req'], frontend: ['ui'], backend: ['ui'], test: ['frontend', 'backend'], deploy: ['test'],
}

function stepsJsonToNodes(stepsJson: any): StepNodeData[] {
  if (!stepsJson?.steps?.length) return DEFAULT_STEPS
  return stepsJson.steps.map((s: any) => ({
    key: s.key || s.id, label: s.label || s.name || s.key,
    engine: s.engine || 'claude', model: s.model || '',
    color: s.color || '#888888', prompt: s.prompt || '',
    inputs: (s.inputs || []).map((i: any) => ({ name: i.name || i, type: i.type || 'document' })),
    outputs: (s.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || 'markdown' })),
  }))
}

function stepsJsonToDeps(stepsJson: any): Record<string, string[]> {
  if (!stepsJson?.steps?.length) return DEFAULT_DEPS
  const deps: Record<string, string[]> = {}
  for (const s of stepsJson.steps) {
    const key = s.key || s.id
    if (s.dependsOn?.length) deps[key] = s.dependsOn
  }
  return deps
}

function buildNodes(steps: StepNodeData[]): Node[] {
  const positions = [
    { x: 50, y: 200 }, { x: 320, y: 200 },
    { x: 590, y: 100 }, { x: 590, y: 300 },
    { x: 860, y: 200 }, { x: 1130, y: 200 },
  ]
  return steps.map((step, i) => ({
    id: step.key, type: 'step',
    position: positions[i] || { x: 50 + i * 270, y: 200 },
    data: step,
  }))
}

function buildEdges(deps: Record<string, string[]>): Edge[] {
  const edges: Edge[] = []
  for (const [target, sources] of Object.entries(deps)) {
    for (const source of sources) {
      edges.push({ id: `${source}-${target}`, source, target, animated: true, style: { stroke: 'var(--border)', strokeWidth: 2 } })
    }
  }
  return edges
}

/* ── Section title ── */
const sectionTitle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8,
}

/* ── IOFieldEditor ── */
function IOFieldEditor({
  label, dotColor, fields, onChange,
}: {
  label: string; dotColor: string; fields: IOField[]
  onChange: (fields: IOField[]) => void
}) {
  const update = (i: number, field: keyof IOField, val: string) => {
    const next = [...fields]
    next[i] = { ...next[i], [field]: val }
    onChange(next)
  }
  const add = () => onChange([...fields, { name: '', type: 'any' }])
  const remove = (i: number) => onChange(fields.filter((_, idx) => idx !== i))

  return (
    <div>
      <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: dotColor }}>●</span> {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {fields.map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              value={f.name} onChange={(e) => update(i, 'name', e.target.value)}
              placeholder="名称" style={{ flex: 1, height: 28, fontSize: 12 }}
            />
            <input
              value={f.type} onChange={(e) => update(i, 'type', e.target.value)}
              placeholder="类型" style={{ width: 64, height: 28, fontSize: 12 }}
            />
            <button className="btn-icon" onClick={() => remove(i)} style={{ width: 24, height: 24, color: 'var(--danger)', fontSize: 14 }}>×</button>
          </div>
        ))}
        <button onClick={add} style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: '4px 0' }}>
          + 添加{label.replace('输入', '').replace('输出', '')}
        </button>
      </div>
    </div>
  )
}

/* ── Canvas Editor Inner (needs ReactFlow context) ── */
function CanvasEditorInner() {
  const navigate = useNavigate()
  const { fitView } = useReactFlow()
  const activeProject = useProjectStore((s) => s.activeProject)

  const stepsData = stepsJsonToNodes(activeProject?.steps)
  const depsData = stepsJsonToDeps(activeProject?.steps)

  const [nodes, setNodes, onNodesChange] = useNodesState(buildNodes(stepsData))
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildEdges(depsData))
  const [selectedNode, setSelectedNode] = useState<StepNodeData | null>(null)
  const [showJson, setShowJson] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const flowRef = useRef<HTMLDivElement>(null)

  /* ── Keyboard shortcuts ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Don't delete if focus is in an input/textarea
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        // Delete selected nodes
        setNodes((nds) => nds.filter((n) => !n.selected))
        setEdges((eds) => eds.filter((ed) => !ed.selected))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setNodes, setEdges])

  /* ── Edge operations ── */
  const onConnect = useCallback((params: Connection) => {
    setEdges((eds) => addEdge({ ...params, animated: true, style: { stroke: 'var(--border)', strokeWidth: 2 } }, eds))
  }, [setEdges])

  const onEdgeDoubleClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setEdges((eds) => eds.filter((e) => e.id !== edge.id))
  }, [setEdges])

  /* ── Node operations ── */
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
    if (selectedNode?.key === nodeId) setSelectedNode(null)
    setContextMenu(null)
  }, [setNodes, setEdges, selectedNode])

  /* ── Update node data ── */
  const updateNodeData = useCallback((key: string, field: string, value: any) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== key) return n
      const updated = { ...n.data as StepNodeData, [field]: value }
      return { ...n, data: updated }
    }))
    if (selectedNode?.key === key) {
      setSelectedNode({ ...selectedNode, [field]: value })
    }
  }, [setNodes, selectedNode])

  /* ── Add node ── */
  const handleAddNode = () => {
    const id = `step_${Date.now()}`
    const newNode: Node = {
      id, type: 'step',
      position: { x: 300 + Math.random() * 200, y: 150 + Math.random() * 200 },
      data: { key: id, label: '新阶段', engine: 'claude', model: '', color: '#888888', prompt: '', inputs: [], outputs: [] } as StepNodeData,
      selected: false,
    }
    setNodes((nds) => [...nds, newNode])
  }

  /* ── Auto layout (topological sort) ── */
  const handleAutoLayout = useCallback(() => {
    const levels: Record<string, number> = {}
    const inDegree: Record<string, number> = {}
    nodes.forEach((n) => { inDegree[n.id] = 0 })
    edges.forEach((e) => { inDegree[e.target] = (inDegree[e.target] || 0) + 1 })

    const queue = nodes.filter((n) => inDegree[n.id] === 0).map((n) => n.id)
    const visited = new Set<string>()
    while (queue.length > 0) {
      const nodeId = queue.shift()!
      if (visited.has(nodeId)) continue
      visited.add(nodeId)
      const currentLevel = levels[nodeId] || 0
      edges.filter((e) => e.source === nodeId).forEach((e) => {
        const targetLevel = currentLevel + 1
        if (!levels[e.target] || levels[e.target] < targetLevel) levels[e.target] = targetLevel
        inDegree[e.target]--
        if (inDegree[e.target] === 0) queue.push(e.target)
      })
    }
    nodes.forEach((n) => { if (levels[n.id] === undefined) levels[n.id] = 0 })

    const groups: Record<number, Node[]> = {}
    nodes.forEach((n) => {
      const lvl = levels[n.id]
      if (!groups[lvl]) groups[lvl] = []
      groups[lvl].push(n)
    })

    setNodes((nds) => nds.map((n) => {
      const lvl = levels[n.id] || 0
      const idx = groups[lvl].indexOf(n)
      return { ...n, position: { x: 50 + lvl * 320, y: 100 + idx * 180 } }
    }))

    setTimeout(() => fitView({ padding: 0.2 }), 100)
  }, [nodes, edges, setNodes, fitView])

  /* ── Save ── */
  const getStepsJson = () => nodes.map((node) => {
    const d = node.data as StepNodeData
    const deps = edges.filter((e) => e.target === node.id).map((e) => e.source)
    return { key: d.key, label: d.label, engine: d.engine, model: d.model, color: d.color, prompt: d.prompt, inputs: d.inputs, outputs: d.outputs, dependsOn: deps }
  })

  const handleSave = async () => {
    if (!activeProject) return
    try {
      await fetch('/api/project/save-steps', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: activeProject.path, steps: { steps: getStepsJson() } }),
      })
      navigate(-1)
    } catch (e) { console.error('Save failed:', e) }
  }

  const handleCopyJson = () => {
    navigator.clipboard.writeText(JSON.stringify({ steps: getStepsJson() }, null, 2))
  }

  /* ── Close context menu on click outside ── */
  useEffect(() => {
    if (!contextMenu) return
    const handler = () => setContextMenu(null)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [contextMenu])

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div style={{
        height: 48, background: 'var(--bg)', borderBottom: '1px solid var(--border-soft)',
        display: 'flex', alignItems: 'center', padding: '0 16px', gap: 12, flexShrink: 0,
      }}>
        <button className="btn-icon" onClick={() => navigate(-1)}>←</button>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}>流程编辑器</span>
        <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
        <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{activeProject?.name || '项目'}</span>
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={() => setShowJson(true)}>{'{ }'} JSON</button>
        <button className="btn-ghost" onClick={handleAutoLayout}>⊞ 布局</button>
        <button className="btn-ghost" onClick={handleAddNode}>+ 阶段</button>
        <button className="btn-primary" onClick={handleSave}>保存</button>
      </div>

      {/* Canvas + Config panel */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }} ref={flowRef}>
        <div style={{ flex: 1 }}>
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeDoubleClick={onEdgeDoubleClick}
            nodeTypes={nodeTypes}
            fitView
            deleteKeyCode={null}
            style={{ background: 'var(--surface)' }}
          >
            <Controls />
            <Background gap={20} size={1} color="var(--border)" />
          </ReactFlow>
        </div>

        {/* ── Config panel ── */}
        {selectedNode && (
          <div style={{
            width: 340, background: 'var(--bg)', borderLeft: '1px solid var(--border-soft)',
            overflowY: 'auto', padding: '20px 16px',
            display: 'flex', flexDirection: 'column', gap: 20,
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 6,
                  background: `${selectedNode.color}20`, color: selectedNode.color,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 600,
                }}>
                  {selectedNode.label.charAt(0)}
                </div>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{selectedNode.label}</span>
              </div>
              <button className="btn-icon" onClick={() => setSelectedNode(null)}>✕</button>
            </div>

            {/* Basic info */}
            <div>
              <div style={sectionTitle}>基本信息</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>名称</label>
                  <input value={selectedNode.label} onChange={(e) => updateNodeData(selectedNode.key, 'label', e.target.value)} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>引擎</label>
                    <select value={selectedNode.engine} onChange={(e) => updateNodeData(selectedNode.key, 'engine', e.target.value)} style={{ height: 32 }}>
                      <option value="claude">Claude Code</option>
                      <option value="codex">Codex CLI</option>
                      <option value="hermes">Hermes ACP</option>
                    </select>
                  </div>
                  <div style={{ width: 60 }}>
                    <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>颜色</label>
                    <input type="color" value={selectedNode.color} onChange={(e) => updateNodeData(selectedNode.key, 'color', e.target.value)} style={{ height: 32, width: '100%', cursor: 'pointer', padding: 2 }} />
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>模型（可选）</label>
                  <input value={selectedNode.model} onChange={(e) => updateNodeData(selectedNode.key, 'model', e.target.value)} placeholder="如 gpt-5.5 / 留空用默认" />
                </div>
              </div>
            </div>

            {/* Inputs */}
            <IOFieldEditor
              label="输入产物" dotColor="var(--accent)"
              fields={selectedNode.inputs}
              onChange={(fields) => updateNodeData(selectedNode.key, 'inputs', fields)}
            />

            {/* Outputs */}
            <IOFieldEditor
              label="输出产物" dotColor="var(--success)"
              fields={selectedNode.outputs}
              onChange={(fields) => updateNodeData(selectedNode.key, 'outputs', fields)}
            />

            {/* Dependencies */}
            <div>
              <div style={sectionTitle}>上游依赖</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {edges.filter((e) => e.target === selectedNode.key).length === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--meta)', fontStyle: 'italic' }}>无（起始阶段）</span>
                )}
                {edges.filter((e) => e.target === selectedNode.key).map((e) => (
                  <span key={e.id} style={{
                    fontSize: 12, padding: '3px 10px', borderRadius: 'var(--radius-pill)',
                    background: 'var(--surface)', color: 'var(--fg-2)', border: '1px solid var(--border-soft)',
                  }}>
                    {e.source}
                  </span>
                ))}
              </div>
            </div>

            {/* Prompt */}
            <div>
              <div style={sectionTitle}>阶段 Prompt</div>
              <textarea
                value={selectedNode.prompt}
                onChange={(e) => updateNodeData(selectedNode.key, 'prompt', e.target.value)}
                rows={8}
                style={{ minHeight: 160, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5 }}
                placeholder="描述这个阶段要做什么..."
              />
            </div>

            {/* Delete */}
            <button
              onClick={() => deleteNode(selectedNode.key)}
              style={{ fontSize: 13, color: 'var(--danger)', border: '1px solid var(--danger)', background: 'transparent', padding: '8px', borderRadius: 'var(--radius-sm)' }}
            >
              删除此阶段
            </button>
          </div>
        )}
      </div>

      {/* ── Context menu ── */}
      {contextMenu && (
        <div style={{
          position: 'fixed', left: contextMenu.x, top: contextMenu.y,
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-raised)',
          padding: '4px 0', zIndex: 500, minWidth: 140,
        }}>
          <div
            onClick={() => {
              const node = nodes.find((n) => n.id === contextMenu.nodeId)
              if (node) setSelectedNode(node.data as StepNodeData)
              setContextMenu(null)
            }}
            style={{ padding: '8px 16px', fontSize: 13, cursor: 'pointer' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            ✏️ 编辑阶段
          </div>
          <div
            onClick={() => deleteNode(contextMenu.nodeId)}
            style={{ padding: '8px 16px', fontSize: 13, cursor: 'pointer', color: 'var(--danger)' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            🗑 删除
          </div>
        </div>
      )}

      {/* ── JSON Preview overlay ── */}
      {showJson && (
        <div className="modal-overlay" onClick={() => setShowJson(false)} style={{ zIndex: 400 }}>
          <div className="modal" style={{ width: 600, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">工作流 JSON 配置</span>
              <button className="btn-icon" onClick={() => setShowJson(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: 0 }}>
              <pre style={{
                margin: 0, padding: 16,
                fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.6,
                background: 'var(--surface)', color: 'var(--fg)',
                overflow: 'auto', maxHeight: '60vh',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {JSON.stringify({ steps: getStepsJson() }, null, 2)}
              </pre>
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={handleCopyJson}>复制</button>
              <button className="btn-primary" onClick={() => setShowJson(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Canvas Editor (with ReactFlowProvider) ── */
export default function CanvasEditor() {
  return (
    <ReactFlowProvider>
      <CanvasEditorInner />
    </ReactFlowProvider>
  )
}
