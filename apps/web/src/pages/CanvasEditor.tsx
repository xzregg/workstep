import { useState, useCallback } from 'react'
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
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useProjectStore } from '../stores/projectStore'

/* ── Step Node ── */
interface StepNodeData {
  key: string
  label: string
  engine: string
  color: string
  prompt: string
  inputs: string[]
  outputs: string[]
  [key: string]: unknown
}

function StepNode({ data }: { data: StepNodeData }) {
  return (
    <div style={{
      width: 220,
      background: 'var(--bg)',
      border: `1.5px solid ${data.color || 'var(--border)'}`,
      borderRadius: 'var(--radius-md)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
      fontFamily: 'var(--font-body)',
    }}>
      <Handle type="target" position={Position.Left} style={{
        width: 10, height: 10, background: 'var(--bg)',
        border: '2px solid var(--border)',
      }} />
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--border-soft)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{
          width: 24, height: 24, borderRadius: 6,
          background: `${data.color}20`,
          color: data.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 600,
        }}>
          {data.label.charAt(0)}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{data.label}</span>
        <span style={{
          fontSize: 10, padding: '2px 6px', borderRadius: 4,
          background: 'var(--surface)', color: 'var(--muted)',
        }}>
          {data.engine}
        </span>
      </div>
      <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--muted)' }}>
        {data.inputs.length > 0 && (
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: 'var(--accent)', fontWeight: 500 }}>输入: </span>
            {data.inputs.join(', ')}
          </div>
        )}
        {data.outputs.length > 0 && (
          <div>
            <span style={{ color: 'var(--success)', fontWeight: 500 }}>输出: </span>
            {data.outputs.join(', ')}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{
        width: 10, height: 10, background: 'var(--bg)',
        border: '2px solid var(--border)',
      }} />
    </div>
  )
}

const nodeTypes: NodeTypes = { step: StepNode }

/* ── Default template ── */
const DEFAULT_STEPS: StepNodeData[] = [
  { key: 'req', label: '需求', engine: 'claude', color: '#0071e3', prompt: '', inputs: ['业务需求'], outputs: ['PRD 文档'] },
  { key: 'ui', label: 'UI 设计', engine: 'claude', color: '#7c3aed', prompt: '', inputs: ['PRD 文档'], outputs: ['UI 设计稿'] },
  { key: 'frontend', label: '前端开发', engine: 'claude', color: '#059669', prompt: '', inputs: ['UI 设计稿'], outputs: ['前端代码'] },
  { key: 'backend', label: '后端开发', engine: 'codex', color: '#d97706', prompt: '', inputs: ['PRD 文档'], outputs: ['API 服务'] },
  { key: 'test', label: '测试', engine: 'codex', color: '#dc2626', prompt: '', inputs: ['前端代码', 'API 服务'], outputs: ['测试报告'] },
  { key: 'deploy', label: '上线', engine: 'hermes', color: '#16a34a', prompt: '', inputs: ['测试报告'], outputs: ['部署完成'] },
]

function buildInitialNodes(steps: StepNodeData[]): Node[] {
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

function buildInitialEdges(_steps: StepNodeData[], deps: Record<string, string[]>): Edge[] {
  const edges: Edge[] = []
  for (const [target, sources] of Object.entries(deps)) {
    for (const source of sources) {
      edges.push({
        id: `${source}-${target}`, source, target,
        animated: true, style: { stroke: 'var(--border)', strokeWidth: 2 },
      })
    }
  }
  return edges
}

const DEFAULT_DEPS: Record<string, string[]> = {
  ui: ['req'], frontend: ['ui'], backend: ['ui'],
  test: ['frontend', 'backend'], deploy: ['test'],
}

function stepsJsonToNodes(stepsJson: { steps: any[] } | null): StepNodeData[] {
  if (!stepsJson?.steps?.length) return DEFAULT_STEPS
  return stepsJson.steps.map((s: any) => ({
    key: s.key || s.id, label: s.label || s.name || s.key,
    engine: s.engine || 'claude', color: s.color || '#888888',
    prompt: s.prompt || '',
    inputs: (s.inputs || []).map((i: any) => typeof i === 'string' ? i : i.name || ''),
    outputs: (s.outputs || []).map((o: any) => typeof o === 'string' ? o : o.name || ''),
  }))
}

function stepsJsonToDeps(stepsJson: { steps: any[] } | null): Record<string, string[]> {
  if (!stepsJson?.steps?.length) return DEFAULT_DEPS
  const deps: Record<string, string[]> = {}
  for (const s of stepsJson.steps) {
    const key = s.key || s.id
    if (s.dependsOn?.length) deps[key] = s.dependsOn
  }
  return deps
}

/* ── Section title style (matching card-detail) ── */
const sectionTitle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: '0.5px',
  marginBottom: 8,
}

/* ── I/O item style (matching card-detail) ── */
function IOItem({ name, type, direction }: { name: string; type?: string; direction: 'in' | 'out' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px',
      background: 'var(--surface)', borderRadius: 6,
      border: '1px solid var(--border-soft)',
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: '50%',
        background: direction === 'in' ? 'var(--accent)' : 'var(--success)',
        flexShrink: 0,
      }} />
      <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{name}</span>
      {type && (
        <span style={{
          fontSize: 11, color: 'var(--meta)',
          background: 'var(--surface)', border: '1px solid var(--border-soft)',
          padding: '0 4px', borderRadius: 3,
        }}>
          {type}
        </span>
      )}
    </div>
  )
}

/* ── Config panel update helper ── */
function useUpdateNode(setNodes: any, selectedNode: StepNodeData | null, setSelectedNode: any) {
  return (field: string, value: string) => {
    if (!selectedNode) return
    const updated = { ...selectedNode, [field]: value }
    setSelectedNode(updated)
    setNodes((nds: Node[]) => nds.map((n: Node) =>
      n.id === selectedNode.key ? { ...n, data: updated } : n
    ))
  }
}

/* ── Canvas Editor Page ── */
export default function CanvasEditor() {
  const navigate = useNavigate()
  const activeProject = useProjectStore((s) => s.activeProject)
  const [selectedNode, setSelectedNode] = useState<StepNodeData | null>(null)
  const [showJson, setShowJson] = useState(false)

  const stepsData = stepsJsonToNodes(activeProject?.steps as any)
  const depsData = stepsJsonToDeps(activeProject?.steps as any)

  const [nodes, setNodes, onNodesChange] = useNodesState(buildInitialNodes(stepsData))
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildInitialEdges(stepsData, depsData))

  const onConnect = useCallback((params: Connection) => {
    setEdges((eds) => addEdge({
      ...params, animated: true,
      style: { stroke: 'var(--border)', strokeWidth: 2 },
    }, eds))
  }, [setEdges])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node.data as StepNodeData)
  }, [])

  const updateField = useUpdateNode(setNodes, selectedNode, setSelectedNode)

  const getStepsJson = () => {
    return nodes.map((node) => {
      const d = node.data as StepNodeData
      const deps = edges.filter((e) => e.target === node.id).map((e) => e.source)
      return {
        key: d.key, label: d.label, engine: d.engine, color: d.color,
        prompt: d.prompt,
        inputs: d.inputs.map((name) => ({ name, type: 'document' })),
        outputs: d.outputs.map((name) => ({ name, type: 'markdown' })),
        dependsOn: deps,
      }
    })
  }

  const handleSave = async () => {
    if (!activeProject) return
    try {
      await fetch('/api/project/save-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: activeProject.path,
          steps: { steps: getStepsJson() },
        }),
      })
      navigate(-1)
    } catch (e) {
      console.error('Save failed:', e)
    }
  }

  const handleAddNode = () => {
    const id = `step_${Date.now()}`
    setNodes((nds) => [...nds, {
      id, type: 'step',
      position: { x: 400 + Math.random() * 200, y: 100 + Math.random() * 300 },
      data: { key: id, label: '新阶段', engine: 'claude', color: '#888888', prompt: '', inputs: [], outputs: [] } as StepNodeData,
    }])
  }

  const handleCopyJson = () => {
    navigator.clipboard.writeText(JSON.stringify({ steps: getStepsJson() }, null, 2))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div style={{
        height: 48, background: 'var(--bg)',
        borderBottom: '1px solid var(--border-soft)',
        display: 'flex', alignItems: 'center', padding: '0 16px', gap: 12,
        flexShrink: 0,
      }}>
        <button className="btn-icon" onClick={() => navigate(-1)}>←</button>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}>
          流程编辑器
        </span>
        <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
        <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>
          {activeProject?.name || '项目'}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={() => setShowJson(true)}>
          {'{ }'} JSON
        </button>
        <button className="btn-ghost" onClick={handleAddNode}>+ 阶段</button>
        <button className="btn-primary" onClick={handleSave}>保存</button>
      </div>

      {/* Canvas + Config panel */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1 }}>
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} onNodeClick={onNodeClick}
            nodeTypes={nodeTypes} fitView
            style={{ background: 'var(--surface)' }}
          >
            <Controls />
            <Background gap={20} size={1} color="var(--border)" />
          </ReactFlow>
        </div>

        {/* ── Config panel (card-detail style) ── */}
        {selectedNode && (
          <div style={{
            width: 340, background: 'var(--bg)',
            borderLeft: '1px solid var(--border-soft)',
            overflowY: 'auto', padding: '20px 16px',
            display: 'flex', flexDirection: 'column', gap: 20,
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 6,
                  background: `${selectedNode.color}20`,
                  color: selectedNode.color,
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
                  <input value={selectedNode.label} onChange={(e) => updateField('label', e.target.value)} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>引擎</label>
                    <select value={selectedNode.engine} onChange={(e) => updateField('engine', e.target.value)} style={{ height: 32 }}>
                      <option value="claude">Claude Code</option>
                      <option value="codex">Codex CLI</option>
                      <option value="hermes">Hermes ACP</option>
                    </select>
                  </div>
                  <div style={{ width: 60 }}>
                    <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>颜色</label>
                    <input type="color" value={selectedNode.color} onChange={(e) => updateField('color', e.target.value)} style={{ height: 32, width: '100%', cursor: 'pointer', padding: 2 }} />
                  </div>
                </div>
              </div>
            </div>

            {/* Inputs */}
            <div>
              <div style={sectionTitle}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--accent)' }}>●</span> 输入产物
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedNode.inputs.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--meta)', fontStyle: 'italic', padding: '4px 0' }}>无输入</div>
                )}
                {selectedNode.inputs.map((input, i) => (
                  <IOItem key={i} name={input} direction="in" type="document" />
                ))}
              </div>
            </div>

            {/* Outputs */}
            <div>
              <div style={sectionTitle}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--success)' }}>●</span> 输出产物
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedNode.outputs.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--meta)', fontStyle: 'italic', padding: '4px 0' }}>无输出</div>
                )}
                {selectedNode.outputs.map((output, i) => (
                  <IOItem key={i} name={output} direction="out" type="markdown" />
                ))}
              </div>
            </div>

            {/* Dependencies */}
            <div>
              <div style={sectionTitle}>上游依赖</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {edges.filter((e) => e.target === selectedNode.key).map((e) => (
                  <span key={e.id} style={{
                    fontSize: 12, padding: '3px 10px', borderRadius: 'var(--radius-pill)',
                    background: 'var(--surface)', color: 'var(--fg-2)',
                    border: '1px solid var(--border-soft)',
                  }}>
                    {e.source}
                  </span>
                ))}
                {edges.filter((e) => e.target === selectedNode.key).length === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--meta)', fontStyle: 'italic' }}>无（起始阶段）</span>
                )}
              </div>
            </div>

            {/* Prompt */}
            <div>
              <div style={sectionTitle}>阶段 Prompt</div>
              <textarea
                value={selectedNode.prompt}
                onChange={(e) => updateField('prompt', e.target.value)}
                rows={8}
                style={{ minHeight: 160, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5 }}
                placeholder="描述这个阶段要做什么..."
              />
            </div>
          </div>
        )}
      </div>

      {/* ── JSON Preview overlay ── */}
      {showJson && (
        <div
          className="modal-overlay"
          onClick={() => setShowJson(false)}
          style={{ zIndex: 400 }}
        >
          <div
            className="modal"
            style={{ width: 600, maxHeight: '80vh' }}
            onClick={(e) => e.stopPropagation()}
          >
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
