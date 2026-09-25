import type { TaskArtifact } from '../api/client'
import type { ProgressGraphStep, ProgressGraphStepProgress } from './TaskStepProgressGraph'

interface GraphNode { column: number; row: number }
interface GraphGeometry { path: string; startX: number; startY: number; endX: number; endY: number }

export const CARD_HEIGHT = 68
export const COLUMN_GAP = 58
export const ROW_HEIGHT = 98
export const GRID_PADDING_X = 28
export const GRID_PADDING_Y = 24

export interface GraphRect {
  left: number
  top: number
  width: number
  height: number
}

export function computeGraphLayout(steps: ProgressGraphStep[]) {
  const keyToIndex = new Map(steps.map((step, index) => [step.key, index]))
  const hasDeclaredGraph = steps.some((step) => (
    (step.dependsOn?.length ?? 0) > 0
    || (step.reworkDependsOn?.length ?? 0) > 0
    || (((step as { deps?: unknown }).deps as unknown[] | undefined)?.length ?? 0) > 0
  ))
  const dependencies = steps.map((step, index) => {
    if (!hasDeclaredGraph) {
      return index === 0 ? [] as number[] : [index - 1]
    }
    const raw = [
      ...(((step as { deps?: unknown }).deps as string[] | undefined) ?? []),
      ...(step.dependsOn ?? []),
    ]
    return [...new Set(raw)]
      .map((key) => keyToIndex.get(key))
      .filter((dep): dep is number => dep !== undefined && dep !== index)
  })
  const dashedDependencies = new Set<string>()
  steps.forEach((step, index) => {
    ;(step.reworkDependsOn ?? []).forEach((key) => {
      const dep = keyToIndex.get(key)
      if (dep === undefined || dep === index) return
      dependencies[index] = [...new Set([...dependencies[index], dep])]
      dashedDependencies.add(`${dep}->${index}`)
    })
  })

  const columnOf = new Array<number>(steps.length).fill(0)
  for (let index = 0; index < steps.length; index += 1) {
    const deps = dependencies[index].filter((dep) => dep < index)
    columnOf[index] = deps.length === 0
      ? 0
      : Math.max(...deps.map((dep) => columnOf[dep])) + 1
  }

  const rowsByColumn = new Map<number, number>()
  const rowOf = steps.map((_, index) => {
    const column = columnOf[index]
    const sameColumnOrder = dependencies
      .map((deps, candidate) => ({ deps, candidate }))
      .filter(({ candidate }) => columnOf[candidate] === column)
      .findIndex(({ candidate }) => candidate === index)
    const row = sameColumnOrder
    rowsByColumn.set(column, Math.max(rowsByColumn.get(column) ?? 0, row))
    return row
  })

  return { dependencies, dashedDependencies, columnOf, rowOf }
}

export function routeEdge(
  source: GraphRect,
  target: GraphRect,
): GraphGeometry {
  const sourceLeft = source.left
  const sourceRight = source.left + source.width
  const sourceTop = source.top
  const sourceBottom = source.top + source.height
  const targetLeft = target.left
  const targetRight = target.left + target.width
  const targetTop = target.top
  const targetBottom = target.top + target.height
  const sourceCenterX = sourceLeft + source.width / 2
  const sourceCenterY = sourceTop + source.height / 2
  const targetCenterX = targetLeft + target.width / 2
  const targetCenterY = targetTop + target.height / 2

  if (targetTop > sourceBottom + 8) {
    const bend = Math.max(22, (targetTop - sourceBottom) * 0.45)
    return {
      path: `M ${sourceCenterX} ${sourceBottom} C ${sourceCenterX} ${sourceBottom + bend}, ${targetCenterX} ${targetTop - bend}, ${targetCenterX} ${targetTop}`,
      startX: sourceCenterX,
      startY: sourceBottom,
      endX: targetCenterX,
      endY: targetTop,
    }
  }

  if (targetBottom < sourceTop - 8) {
    const bend = Math.max(22, (sourceTop - targetBottom) * 0.45)
    return {
      path: `M ${sourceCenterX} ${sourceTop} C ${sourceCenterX} ${sourceTop - bend}, ${targetCenterX} ${targetBottom + bend}, ${targetCenterX} ${targetBottom}`,
      startX: sourceCenterX,
      startY: sourceTop,
      endX: targetCenterX,
      endY: targetBottom,
    }
  }

  if (targetLeft > sourceRight + 8) {
    const bend = Math.max(24, (targetLeft - sourceRight) * 0.48)
    return {
      path: `M ${sourceRight} ${sourceCenterY} C ${sourceRight + bend} ${sourceCenterY}, ${targetLeft - bend} ${targetCenterY}, ${targetLeft} ${targetCenterY}`,
      startX: sourceRight,
      startY: sourceCenterY,
      endX: targetLeft,
      endY: targetCenterY,
    }
  }

  if (targetRight < sourceLeft - 8) {
    const bend = Math.max(28, (sourceLeft - targetRight) * 0.42)
    return {
      path: `M ${sourceLeft} ${sourceCenterY} C ${sourceLeft - bend} ${sourceCenterY + 26}, ${targetRight + bend} ${targetCenterY + 26}, ${targetRight} ${targetCenterY}`,
      startX: sourceLeft,
      startY: sourceCenterY,
      endX: targetRight,
      endY: targetCenterY,
    }
  }

  const bend = 28
  return {
    path: `M ${sourceRight} ${sourceCenterY} C ${sourceRight + bend} ${sourceCenterY}, ${targetRight + bend} ${targetCenterY}, ${targetRight} ${targetCenterY}`,
    startX: sourceRight,
    startY: sourceCenterY,
    endX: targetRight,
    endY: targetCenterY,
  }
}

export function nodeRect(node: GraphNode, cardWidth: number): GraphRect {
  return {
    left: GRID_PADDING_X + node.column * (cardWidth + COLUMN_GAP),
    top: GRID_PADDING_Y + node.row * ROW_HEIGHT,
    width: cardWidth,
    height: CARD_HEIGHT,
  }
}

export function deriveStepRounds(
  runRound: number,
  restartFromStepKey: string | undefined,
  steps: ProgressGraphStep[],
  stepProgress: ProgressGraphStepProgress[],
  artifacts: TaskArtifact[],
) {
  const restartIndex = restartFromStepKey
    ? steps.findIndex((step) => step.key === restartFromStepKey)
    : -1

  return steps.map((step, index) => {
    const progress = stepProgress[index]
    const runRoundForStep = restartIndex >= 0 && index < restartIndex
      ? Math.max(1, runRound - 1)
      : runRound
    const artifactRound = artifacts
      .filter((artifact) => artifact.step_key === step.key)
      .reduce((maxRound, artifact) => Math.max(maxRound, artifact.round || 0), 0)
    const progressArtifactRound = progress?.artifact_round ?? 0
    const stepArtifactRound = Math.max(artifactRound, progressArtifactRound)
    return stepArtifactRound > 0 ? stepArtifactRound : runRoundForStep
  })
}

