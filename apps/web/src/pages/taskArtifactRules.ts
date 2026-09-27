import { collapseDirectoryArtifactChildren } from '../utils/artifactListing'

export interface ArtifactRoundChoice {
  step_key: string
  round: number
  is_latest: boolean
  is_selected: boolean
  logical_name?: string | null
  name: string
}

export function artifactsForStepRoundOutputs<
  T extends ArtifactRoundChoice & {
    declared_output?: boolean
    logical_name?: string | null
    path?: string
    is_dir?: boolean
  },
>(
  artifacts: readonly T[],
  stepKey: string,
  round: number | undefined,
): T[] {
  if (round === undefined) return []
  const matching = artifacts.filter((artifact) => (
    artifact.step_key === stepKey && artifact.round === round
  ))
  const collapsed = collapseDirectoryArtifactChildren(matching)
  const preferred = collapsed.filter((artifact) => (
    artifact.is_dir || artifact.declared_output === true
  ))
  if (preferred.length > 0) return preferred
  return collapsed.filter((artifact) => (
    artifact.declared_output !== false && Boolean(artifact.logical_name)
  ))
}

export function groupStepOutputsByInput<
  T extends { name: string; logical_name?: string | null; artifact_type?: string | null; is_dir?: boolean; output_port?: number | null },
>(
  inputs: readonly { outputs?: readonly { name: string; type: string }[] }[],
  outputs: readonly { name: string; type: string }[],
  produced: readonly T[],
) {
  const groups: Array<Array<{ name: string; type: string; outputIndex: number; artifact?: T }>> =
    inputs.map(() => [])
  const hasNestedOutputs = inputs.some((input) => input.outputs?.length)
  let outputIndex = 0
  inputs.forEach((input, inputIndex) => {
    const declared = hasNestedOutputs ? input.outputs || [] : inputIndex === 0 ? outputs : []
    declared.forEach((output) => {
      groups[inputIndex].push({ ...output, outputIndex: outputIndex++ })
    })
  })
  if (!produced.length) return groups

  const available = groups.flatMap((group, inputIndex) =>
    group.map((output) => ({ output, inputIndex })))
  const result = inputs.map(() => [] as typeof groups[number])
  produced.forEach((artifact) => {
    const name = artifact.logical_name || artifact.name
    const portMatchIndex = artifact.output_port == null ? -1 :
      available.findIndex(({ output }) => output.outputIndex === artifact.output_port)
    const matchIndex = portMatchIndex >= 0 ? portMatchIndex :
      available.findIndex(({ output }) => output.name === name)
    const match = matchIndex >= 0 ? available.splice(matchIndex, 1)[0] : undefined
    const inputIndex = match?.inputIndex ?? 0
    result[inputIndex].push({
      name,
      type: artifact.artifact_type || (artifact.is_dir ? 'directory' : 'file'),
      outputIndex: match?.output.outputIndex ?? -1,
      artifact,
    })
  })
  return result
}

export function downstreamInputsForOutput(
  steps: readonly {
    key: string
    nodeId?: string | number
    label: string
    inputs: readonly { name: string }[]
  }[],
  connections: readonly {
    from: string | number
    fromPort?: number
    to: string | number
    toPort?: number
    kind?: string
  }[],
  sourceStepKey: string,
  outputPort: number,
): Array<{ stepKey: string; stepLabel: string; inputName: string }> {
  const source = steps.find((step) => step.key === sourceStepKey)
  if (!source) return []
  const byNodeId = new Map(steps.map((step) => [String(step.nodeId ?? step.key), step]))
  const sourceNodeId = String(source.nodeId ?? source.key)
  const targets: Array<{ stepKey: string; stepLabel: string; inputName: string }> = []
  const seen = new Set<string>()
  for (const connection of connections) {
    if (connection.kind === 'dashed'
      || String(connection.from) !== sourceNodeId
      || (connection.fromPort ?? 0) !== outputPort) continue
    const target = byNodeId.get(String(connection.to))
    const input = target?.inputs[connection.toPort ?? 0]
    if (!target || !input) continue
    const id = `${target.key}:${connection.toPort ?? 0}`
    if (seen.has(id)) continue
    seen.add(id)
    targets.push({ stepKey: target.key, stepLabel: target.label, inputName: input.name })
  }
  return targets
}

interface StepRoundInputSnapshotChoice {
  step_key: string
  round: number
  ports: Array<{
    port: number
    name?: string
    status?: string
    sources: Array<{ step: string; round: number; path: string; name: string }>
  }>
}

export function findStepRoundInputPort(
  snapshots: readonly StepRoundInputSnapshotChoice[],
  stepKey: string,
  stepRound: number | undefined,
  inputPort: number,
) {
  if (stepRound === undefined) return undefined
  return snapshots.find((item) => (
    item.step_key === stepKey && item.round === stepRound
  ))?.ports.find((port) => port.port === inputPort)
}

export function findStepRoundInputArtifact<
  T extends ArtifactRoundChoice & { path: string },
>(
  artifacts: readonly T[],
  snapshots: readonly StepRoundInputSnapshotChoice[],
  stepKey: string,
  stepRound: number | undefined,
  inputPort: number,
): T | undefined {
  const source = findStepRoundInputPort(
    snapshots,
    stepKey,
    stepRound,
    inputPort,
  )?.sources[0]
  if (!source) return undefined
  return artifacts.find((artifact) => artifact.path === source.path)
    ?? artifacts.find((artifact) => (
      artifact.step_key === source.step
      && artifact.round === source.round
      && (artifact.logical_name === source.name || artifact.name === source.name)
    ))
}

interface StepIoContractChoice {
  key: string
  inputs?: Array<{ name?: string; type?: string; outputs?: Array<{ name?: string; type?: string }> }>
  outputs?: Array<{ name?: string; type?: string }>
}

function normalizedIoContract(step: StepIoContractChoice | Record<string, any>) {
  const inputs = Array.isArray(step.inputs) ? step.inputs : []
  const outputs = Array.isArray(step.outputs)
    ? step.outputs
    : (Array.isArray(inputs[0]?.outputs) ? inputs[0].outputs : [])
  const normalizePorts = (ports: Array<{ name?: string; type?: string }>) => (
    ports.map((port) => ({
      name: String(port?.name ?? '').trim(),
      type: String(port?.type ?? 'any').trim().toLocaleLowerCase(),
    }))
  )
  return {
    inputs: normalizePorts(inputs),
    outputs: normalizePorts(outputs),
  }
}

export function hasStepIoContractChanged(
  currentStep: StepIoContractChoice,
  executedContract: any,
): boolean {
  if (!executedContract || typeof executedContract !== 'object') return false
  return JSON.stringify(normalizedIoContract(currentStep))
    !== JSON.stringify(normalizedIoContract(executedContract))
}

export function findPreferredArtifact<
  T extends ArtifactRoundChoice & { path?: string },
>(
  artifacts: readonly T[],
  name: string,
  preferredStepKey?: string,
  preferredRound?: number,
  preferredPath?: string,
): T | undefined {
  const normalize = (value: string) =>
    value.toLocaleLowerCase().replace(/[\s_.-]/g, '')
  const normalizedName = normalize(name)
  const candidates = preferredStepKey
    ? artifacts.filter((artifact) => artifact.step_key === preferredStepKey)
    : artifacts
  const roundCandidates = preferredRound === undefined
    ? candidates
    : candidates.filter((artifact) => artifact.round === preferredRound)
  const preferred = roundCandidates.filter((artifact) => artifact.is_selected)
  const latest = roundCandidates.filter((artifact) => artifact.is_latest)
  const ordered = [...preferred, ...latest, ...roundCandidates]
  return (
    (preferredPath
      ? ordered.find((artifact) => artifact.path === preferredPath)
      : undefined) ||
    ordered.find((artifact) => artifact.logical_name === name) ||
    ordered.find((artifact) => {
      const artifactName = normalize(
        artifact.logical_name || artifact.name,
      )
      return (
        artifactName.includes(normalizedName) ||
        normalizedName.includes(artifactName)
      )
    })
  )
}

export function artifactsForMessage<
  T extends ArtifactRoundChoice & { path?: string; is_dir?: boolean },
>(
  artifacts: readonly T[],
  stepKey: string,
  artifactRound?: number | null,
): T[] {
  if (!artifactRound) return []
  return collapseDirectoryArtifactChildren(artifacts.filter((artifact) => (
    artifact.step_key === stepKey && artifact.round === artifactRound
  )))
}
