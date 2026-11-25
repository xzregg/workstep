import { useCallback, useEffect, useRef, useState } from 'react'
import { useReactFlow, type Node, type Edge, type NodeChange } from '@xyflow/react'
import { canvasToFlowNodes, canvasToFlowEdges, loadCanvasData } from '../components/flowCanvasData'
import { projectFlowProposal, type FlowGraph } from '../utils/flowProposalPreview'

/** Owns only transient rendering; the canvas's real nodes/edges remain authoritative. */
export function useFlowProposalPreview(nodes: Node[], edges: Edge[]) {
  const { fitView } = useReactFlow()
  const [measurements, setMeasurements] = useState<Record<string, { width: number; height: number }>>({})
  const [preview, setPreview] = useState<FlowGraph | null>(null)
  const [applied, setApplied] = useState<FlowGraph | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setPreview(null)
    setApplied(null)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const previewSteps = useCallback((steps: any | null) => {
    clear()
    if (steps === null) return
    const data = loadCanvasData(steps)
    setPreview({ nodes: canvasToFlowNodes(data.nodes), edges: canvasToFlowEdges(data.connections, data.nodes) })
  }, [clear])
  const animateApply = useCallback((next: FlowGraph) => {
    clear()
    const projection = projectFlowProposal({ nodes, edges }, next, 'applied')
    if (!projection.nodes.some(node => node.data.proposalChange) && !projection.edges.some(edge => edge.className?.includes('flow-proposal-edge'))) return
    setApplied(projection)
    // One finite timer: no background animation loop, and nothing persists into JSON.
    timer.current = setTimeout(() => { setApplied(null); timer.current = null }, 1800)
  }, [nodes, edges, clear])
  useEffect(() => {
    if (!preview) return
    const id = setTimeout(() => void fitView({ padding: 0.25, duration: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 350 }), 100)
    return () => clearTimeout(id)
  }, [preview, fitView])
  const onDisplayNodesChange = useCallback((changes: NodeChange[]) => {
    const dimensions = changes.filter(change => change.type === 'dimensions' && change.dimensions)
    if (!dimensions.length) return
    setMeasurements(previous => {
      const next = { ...previous }
      let changed = false
      for (const change of dimensions) {
        if (change.type !== 'dimensions' || !change.dimensions) continue
        const size = change.dimensions
        if (next[change.id]?.width !== size.width || next[change.id]?.height !== size.height) {
          next[change.id] = size
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [])
  const displayed = preview ? projectFlowProposal({ nodes, edges }, preview, 'preview') : applied ?? { nodes, edges }
  return { ...displayed, nodes: displayed.nodes.map(node => measurements[node.id] ? { ...node, measured: measurements[node.id] } : node), onDisplayNodesChange, previewing: preview !== null, applying: applied !== null, previewSteps, animateApply, clear }
}
