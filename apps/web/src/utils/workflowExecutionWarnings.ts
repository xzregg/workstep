export interface WorkflowExecutionWarning {
  target: string
}

interface WorkflowNode {
  id: string | number
  title?: string
  inputs?: Array<{ outputs?: Array<{ name?: string }> }>
}

interface WorkflowConnection {
  from: string | number
  fromPort?: number
  to: string | number
  toPort?: number
  kind?: string
}

/** Warn when a verifier requires an output produced from its own feedback input. */
export function findWorkflowExecutionWarnings(workflow: {
  nodes?: WorkflowNode[]
  connections?: WorkflowConnection[]
}): WorkflowExecutionWarning[] {
  const nodes = new Map((workflow.nodes || []).map((node) => [String(node.id), node]))
  const connections = workflow.connections || []
  const warnedTargets = new Set<string>()
  const warnings: WorkflowExecutionWarning[] = []
  for (const connection of connections) {
    if (connection.kind === 'dashed') continue
    const sourceId = String(connection.from)
    const targetId = String(connection.to)
    if (warnedTargets.has(targetId)) continue
    const source = nodes.get(sourceId)
    const target = nodes.get(targetId)
    if (!source || !target) continue

    let firstOutputPort = 0
    const feedbackInputPort = (source.inputs || []).findIndex((input) => {
      const outputCount = input.outputs?.length || 0
      const ownsOutput = (connection.fromPort ?? 0) >= firstOutputPort
        && (connection.fromPort ?? 0) < firstOutputPort + outputCount
      firstOutputPort += outputCount
      return ownsOutput
    })
    if (feedbackInputPort < 0) continue
    const dependsOnOwnFeedback = connections.some((feedback) => (
      feedback.kind === 'dashed'
      && String(feedback.from) === targetId
      && String(feedback.to) === sourceId
      && (feedback.toPort ?? 0) === feedbackInputPort
    ))
    if (!dependsOnOwnFeedback) continue
    warnedTargets.add(targetId)
    warnings.push({ target: target.title || targetId })
  }
  return warnings
}
