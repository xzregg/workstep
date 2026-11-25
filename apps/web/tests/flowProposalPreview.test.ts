import assert from 'node:assert/strict'
import test from 'node:test'
import { canvasToFlowNodes, canvasToFlowEdges, loadCanvasData } from '../src/components/flowCanvasData'
import { projectFlowProposal, layoutProposalNodes } from '../src/utils/flowProposalPreview'

function graph(steps: any) {
  const data = loadCanvasData(steps)
  return { nodes: canvasToFlowNodes(data.nodes), edges: canvasToFlowEdges(data.connections, data.nodes) }
}
const base = graph({ nodes: [
  { id: 1, type: 'collect', title: '采集', position: { x: 40, y: 100 } },
  { id: 2, type: 'write', title: '撰写', position: { x: 360, y: 100 } },
  { id: 3, type: 'manual', title: '整理', position: { x: 680, y: 100 } },
], connections: [{ from: 1, to: 2 }, { from: 2, to: 3 }] })
const next = graph({ nodes: [
  { id: 1, type: 'collect', title: '采集' },
  { id: 2, type: 'write', title: '按主题归纳' },
  { id: 4, type: 'check', title: '核查', position: { x: 360, y: 100 } },
], connections: [{ from: 1, to: 2 }, { from: 2, to: 4 }] })

test('preview projects all three changes without mutating the authoritative graph', () => {
  const before = JSON.stringify(base)
  const projected = projectFlowProposal(base, next, 'preview')
  assert.equal(JSON.stringify(base), before)
  assert.equal(projected.nodes.find(n => n.id === '2')?.data.label, '按主题归纳')
  assert.equal(projected.nodes.find(n => n.id === '2')?.data.proposalChange, 'updated')
  assert.equal(projected.nodes.find(n => n.id === '4')?.data.proposalChange, 'added')
  assert.equal(projected.nodes.find(n => n.id === '3')?.data.proposalChange, 'removed')
  assert.ok(projected.nodes.filter(n => n.data.proposalChange).every(n => n.draggable === false && n.deletable === false))
  assert.ok(projected.edges.some(e => e.className?.includes('proposal-edge--added')))
  assert.ok(projected.edges.some(e => e.className?.includes('proposal-edge--removed')))
  assert.equal(projected.nodes.find(n => n.id === '1')?.data.proposalChange, undefined)
})

test('preserves existing positions and finds a non-overlapping position for inserted steps', () => {
  const laid = layoutProposalNodes(base.nodes, next.nodes)
  assert.deepEqual(laid.find(n => n.id === '2')?.position, { x: 360, y: 100 })
  const added = laid.find(n => n.id === '4')!
  assert.ok(base.nodes.every(n => Math.abs(n.position.x - added.position.x) >= 300 || Math.abs(n.position.y - added.position.y) >= 180))
})

test('apply retains removed nodes only as noninteractive exit decorations', () => {
  const projected = projectFlowProposal(base, next, 'applied')
  const removed = projected.nodes.find(n => n.id === '3')!
  assert.equal(removed.data.proposalPhase, 'applied')
  assert.equal(removed.selectable, false)
  assert.match(removed.className || '', /proposal-node--removed/)
  assert.equal(projected.nodes.find(n => n.id === '2')?.data.proposalPhase, 'applied')
})

test('same graph is not marked changed due to object key order', () => {
  const reordered = graph({ nodes: [{ title: '采集', type: 'collect', id: 1, position: { y: 100, x: 40 } }], connections: [] })
  const original = { nodes: [base.nodes[0]], edges: [] }
  assert.ok(projectFlowProposal(original, reordered, 'preview').nodes.every(n => !n.data.proposalChange))
})
