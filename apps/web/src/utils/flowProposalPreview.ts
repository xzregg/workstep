import type { Node, Edge } from '@xyflow/react'

export type ProposalPhase = 'preview' | 'applied'
export type ProposalChange = 'added' | 'updated' | 'removed'
export interface FlowGraph { nodes: Node[]; edges: Edge[] }

// Object ordering is not a workflow change. Positions are compared separately.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'position').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${key}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? ''
}

/** Keep manual layout when the assistant omitted positions; avoid stacking new cards. */
export function layoutProposalNodes(current: Node[], candidate: Node[]): Node[] {
  const old = new Map(current.map(node => [node.id, node]))
  const occupied = current.map(node => node.position)
  return candidate.map(node => {
    const previous = old.get(node.id)
    let position = previous && !node.data.position ? previous.position : node.position
    if (!previous) {
      position = { ...position }
      while (occupied.some(p => Math.abs(p.x - position.x) < 300 && Math.abs(p.y - position.y) < 180)) {
        position.y += 180
      }
      occupied.push(position)
    }
    return { ...node, position }
  })
}

const edgeKey = (edge: Edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle, edge.data?.kind ?? 'solid'].join(':')

/** Display-only projection. Never pass this graph to save, execute or getSteps. */
export function projectFlowProposal(current: FlowGraph, candidate: FlowGraph, phase: ProposalPhase): FlowGraph {
  const old = new Map(current.nodes.map(node => [node.id, node]))
  const next = new Map(candidate.nodes.map(node => [node.id, node]))
  const decorate = (node: Node, change: ProposalChange): Node => ({
    ...node,
    className: `${node.className || ''} flow-proposal-node flow-proposal-node--${change} flow-proposal-node--${phase}`.trim(),
    draggable: false, connectable: false, selectable: false, deletable: false,
    data: { ...node.data, proposalChange: change, proposalPhase: phase, proposalPreviousTitle: old.get(node.id)?.data.label },
  })
  const nodes = layoutProposalNodes(current.nodes, candidate.nodes).map(node => {
    const previous = old.get(node.id)
    if (!previous) return decorate(node, 'added')
    if (canonical(previous.data) !== canonical(node.data) || previous.position.x !== node.position.x || previous.position.y !== node.position.y) return decorate(node, 'updated')
    return node
  })
  for (const node of current.nodes) {
    if (!next.has(node.id) && node.type !== 'bookmark') nodes.push(decorate(node, 'removed'))
    else if (node.type === 'bookmark' && !next.has(node.id)) nodes.push(node)
  }
  const oldEdges = new Set(current.edges.map(edgeKey))
  const nextEdges = new Set(candidate.edges.map(edgeKey))
  const edges = candidate.edges.map(edge => oldEdges.has(edgeKey(edge)) ? edge : ({
    ...edge, id: `proposal-${edge.id}`, selectable: false, deletable: false,
    className: `flow-proposal-edge--added flow-proposal-edge--${phase}`,
  }))
  for (const edge of current.edges) {
    if (!nextEdges.has(edgeKey(edge))) edges.push({ ...edge, id: `retired-${edge.id}`, selectable: false, deletable: false,
      className: `flow-proposal-edge--removed flow-proposal-edge--${phase}` })
  }
  return { nodes, edges }
}
