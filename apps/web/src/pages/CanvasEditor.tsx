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

const nodeTypes: NodeTypes = {
  step: StepNode,
}

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
    { x: 50, y: 200 },    // req
    { x: 320, y: 200 },   // ui
    { x: 590, y: 100 },   // frontend
    { x: 590, y: 300 },   // backend
    { x: 860, y: 200 },   // test
    { x: 1130, y: 200 },  // deploy
  ]
  return steps.map((step, i) => ({
    id: step.key,
    type: 'step',
    position: positions[i] || { x: 50 + i * 270, y: 200 },
    data: step,
  }))
}

function buildInitialEdges(_steps: StepNodeData[], deps: Record<string, string[]>): Edge[] {
  const edges: Edge[] = []
  for (const [target, sources] of Object.entries(deps)) {
    for (const source of sources) {
      edges.push({
        id: `${source}-${target}`,
        source,
        target,
        animated: true,
        style: { stroke: 'var(--border)', strokeWidth: 2 },
      })
    }
  }
  return edges
}

const DEFAULT_DEPS: Record<string, string[]> = {
  ui: ['req'],
  frontend: ['ui'],
  backend: ['ui'],
  test: ['frontend', 'backend'],
  deploy: ['test'],
}

/* ── Convert steps.json → nodes + edges ── */
function stepsJsonToNodes(stepsJson: { steps: any[] } | null): StepNodeData[] {
  if (!stepsJson?.steps?.length) return DEFAULT_STEPS
  return stepsJson.steps.map((s: any) => ({
    key: s.key || s.id,
    label: s.label || s.name || s.key,
    engine: s.engine || 'claude',
    color: s.color || '#888888',
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
    if (s.dependsOn?.length) {
      deps[key] = s.dependsOn
    }
  }
  return deps
}

/* ── Canvas Editor Page ── */
export default function CanvasEditor() {
  const navigate = useNavigate()
  const activeProject = useProjectStore((s) => s.activeProject)
  const [selectedNode, setSelectedNode] = useState<StepNodeData | null>(null)

  // Load from project's steps.json, fallback to default template
  const stepsData = stepsJsonToNodes(activeProject?.steps as any)
  const depsData = stepsJsonToDeps(activeProject?.steps as any)

  const [nodes, setNodes, onNodesChange] = useNodesState(
    buildInitialNodes(stepsData)
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    buildInitialEdges(stepsData, depsData)
  )

  const onConnect = useCallback((params: Connection) => {
    setEdges((eds) => addEdge({
      ...params,
      animated: true,
      style: { stroke: 'var(--border)', strokeWidth: 2 },
    }, eds))
  }, [setEdges])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node.data as StepNodeData)
  }, [])

  const handleSave = async () => {
    if (!activeProject) return

    // Convert nodes + edges back to steps.json format
    const steps = nodes.map((node) => {
      const data = node.data as StepNodeData
      const deps = edges
        .filter((e) => e.target === node.id)
        .map((e) => e.source)
      return {
        key: data.key,
        label: data.label,
        engine: data.engine,
        color: data.color,
        prompt: data.prompt,
        inputs: data.inputs.map((name) => ({ name, type: 'document' })),
        outputs: data.outputs.map((name) => ({ name, type: 'markdown' })),
        dependsOn: deps,
      }
    })

    try {
      await fetch('/api/project/save-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: activeProject.path,
          steps: { steps },
        }),
      })
      navigate(-1)
    } catch (e) {
      console.error('Save failed:', e)
    }
  }

  const handleAddNode = () => {
    const id = `step_${Date.now()}`
    const newNode: Node = {
      id,
      type: 'step',
      position: { x: 400 + Math.random() * 200, y: 100 + Math.random() * 300 },
      data: {
        key: id,
        label: '新阶段',
        engine: 'claude',
        color: '#888888',
        prompt: '',
        inputs: [],
        outputs: [],
      } as StepNodeData,
    }
    setNodes((nds) => [...nds, newNode])
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
        <button className="btn-ghost" onClick={handleAddNode}>+ 阶段</button>
        <button className="btn-primary" onClick={handleSave}>保存</button>
      </div>

      {/* Canvas + Config panel */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Canvas */}
        <div style={{ flex: 1 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            style={{ background: 'var(--surface)' }}
          >
            <Controls />
            <Background gap={20} size={1} color="var(--border)" />
          </ReactFlow>
        </div>

        {/* Config panel */}
        {selectedNode && (
          <div style={{
            width: 320, background: 'var(--bg)',
            borderLeft: '1px solid var(--border-soft)',
            overflowY: 'auto', padding: 16,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 16,
            }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>阶段配置</span>
              <button className="btn-icon" onClick={() => setSelectedNode(null)}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-2)' }}>名称</label>
                <input
                  value={selectedNode.label}
                  onChange={(e) => {
                    const updated = { ...selectedNode, label: e.target.value }
                    setSelectedNode(updated)
                    setNodes((nds) => nds.map((n) =>
                      n.id === selectedNode.key ? { ...n, data: updated } : n
                    ))
                  }}
                  style={{ marginTop: 4 }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-2)' }}>引擎</label>
                <select
                  value={selectedNode.engine}
                  onChange={(e) => {
                    const updated = { ...selectedNode, engine: e.target.value }
                    setSelectedNode(updated)
                    setNodes((nds) => nds.map((n) =>
                      n.id === selectedNode.key ? { ...n, data: updated } : n
                    ))
                  }}
                  style={{ marginTop: 4, height: 32 }}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex CLI</option>
                  <option value="hermes">Hermes ACP</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-2)' }}>颜色</label>
                <input
                  type="color"
                  value={selectedNode.color}
                  onChange={(e) => {
                    const updated = { ...selectedNode, color: e.target.value }
                    setSelectedNode(updated)
                    setNodes((nds) => nds.map((n) =>
                      n.id === selectedNode.key ? { ...n, data: updated } : n
                    ))
                  }}
                  style={{ marginTop: 4, height: 32, cursor: 'pointer' }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-2)' }}>Prompt</label>
                <textarea
                  value={selectedNode.prompt}
                  onChange={(e) => {
                    const updated = { ...selectedNode, prompt: e.target.value }
                    setSelectedNode(updated)
                    setNodes((nds) => nds.map((n) =>
                      n.id === selectedNode.key ? { ...n, data: updated } : n
                    ))
                  }}
                  rows={6}
                  style={{ marginTop: 4, minHeight: 120 }}
                  placeholder="阶段专属 prompt..."
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
