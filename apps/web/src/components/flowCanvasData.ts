import type { Node, Edge } from '@xyflow/react'
import type { ChatQuickButton } from '../api/client'
import { DEFAULT_OUTPUT_TYPE } from '../config/outputTypes'
import { normalizeStepConfig } from '../utils/stepConfig'

export interface SubOutput { name: string; type: string }
export interface InputField { name: string; type: string; outputs: SubOutput[] }
export interface OutputField { name: string; type: string }
export const DEFAULT_MAX_RETURN_ROUNDS = 3
export const MAX_CONFIGURED_RETURN_ROUNDS = 20

export function normalizeMaxReturnRounds(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return DEFAULT_MAX_RETURN_ROUNDS
  return Math.max(1, Math.min(MAX_CONFIGURED_RETURN_ROUNDS, parsed))
}

export interface ReviewConfig {
  mode: 'skip' | 'auto' | 'manual'
  auto: boolean
  maxRetries: number
  engine: string
  model: string
  prompt: string
  config: Record<string, string>
}

export const emptyReview = (): ReviewConfig => ({
  mode: 'manual',
  auto: false,
  maxRetries: 1,
  engine: '',
  model: '',
  prompt: '',
  config: {},
})

export interface StepNodeData {
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
  quickButtons?: ChatQuickButton[]
  [k: string]: unknown
}

export function syncOutputs(inputs: InputField[]): OutputField[] {
  return inputs.flatMap((inp) => inp.outputs || [])
}

export interface CanvasConnection {
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

export function canvasToFlowNodes(nodesData: StepNodeData[]): Node[] {
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

export function canvasToFlowEdges(conns: CanvasConnection[], nodesData: StepNodeData[]): Edge[] {
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

export function loadCanvasData(stepsJson: any): { nodes: StepNodeData[]; connections: CanvasConnection[] } {
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
        quickButtons: Array.isArray(n.quickButtons) ? n.quickButtons : [],
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
      quickButtons: Array.isArray(s.quickButtons) ? s.quickButtons : [],
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

export const STEP_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/
const STAGE_COLOR_PALETTE = [
  '#0071e3', '#7c3aed', '#db2777', '#dc2626',
  '#d97706', '#16a34a', '#059669', '#0891b2',
  '#2563eb', '#4f46e5', '#9333ea', '#c026d3',
]

export function randomStepColor(currentColor?: string) {
  const candidates = STAGE_COLOR_PALETTE.filter((color) => color !== currentColor)
  return candidates[Math.floor(Math.random() * candidates.length)]
}
