import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { TKey } from '../i18n'
import { useI18n } from '../i18n'
import { formatDurationBetween, toMilliseconds } from '../utils/datetime'
import type { TaskArtifact, TaskStepState } from '../api/client'
import type { StepVisualState } from './TaskDetailView'
import MarqueeText from './MarqueeText'
import Icon, { type IconName } from './Icon'
import './TaskStepProgressGraph.css'
import { COLUMN_GAP, ROW_HEIGHT, GRID_PADDING_X, GRID_PADDING_Y,
  computeGraphLayout, routeEdge, nodeRect, deriveStepRounds } from './taskStepProgressLayout'

export interface ProgressGraphStep {
  key: string
  label: string
  color: string
  nodeId?: string | number
  dependsOn?: string[]
  reworkDependsOn?: string[]
}

export interface ProgressGraphStepProgress extends Partial<TaskStepState> {
  visualState: StepVisualState
  created_at?: string | null
  updated_at?: string | null
}

interface TaskStepProgressGraphProps {
  taskStatus: string
  runRound: number
  restartFromStepKey?: string
  steps: ProgressGraphStep[]
  stepProgress: ProgressGraphStepProgress[]
  artifacts: TaskArtifact[]
  selectedStep: number
  durationNowMs: number
  onStepClick: (index: number) => void
}

const ACTIVE_STATES: StepVisualState[] = [
  'current',
  'reviewing',
  'awaiting_review',
  'retrying',
  'rework',
  'rework_waiting',
]

const SPINNING_STATES: StepVisualState[] = [
  'current',
  'reviewing',
  'retrying',
  'rework',
]

const STATE_LABEL_KEYS: Record<StepVisualState, TKey> = {
  completed: 'status.done',
  current: 'status.running',
  reviewing: 'status.reviewing',
  awaiting_review: 'status.awaiting_review',
  retrying: 'status.retrying',
  rework: 'status.rework',
  rework_waiting: 'status.rework_waiting',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
  skipped: 'status.skipped',
  pending: 'status.pending',
}

const STATE_ICONS: Record<StepVisualState, IconName> = {
  completed: 'check',
  current: 'loader-circle',
  reviewing: 'search',
  awaiting_review: 'clock',
  retrying: 'loader-circle',
  rework: 'undo-2',
  rework_waiting: 'clock',
  failed: 'x',
  cancelled: 'stop',
  skipped: 'chevron-right',
  pending: 'clock',
}

const CARD_WIDTH_MIN = 80
const CARD_WIDTH_MAX = 116
const ZOOM_MIN = 0.6
const ZOOM_MAX = 1.6
const ZOOM_STEP = 0.1

interface GraphNode {
  step: ProgressGraphStep
  index: number
  progress?: ProgressGraphStepProgress
  visualState: StepVisualState
  round: number
  column: number
  row: number
}

interface EdgeRoute {
  key: string
  path: string
  startX: number
  startY: number
  endX: number
  endY: number
  active: boolean
  flowing: boolean
  dashed: boolean
}

function isActiveState(state: StepVisualState) {
  return ACTIVE_STATES.includes(state)
}

function isSpinningState(state: StepVisualState) {
  return SPINNING_STATES.includes(state)
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function clampZoom(value: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 10) / 10))
}

export default function TaskStepProgressGraph({
  taskStatus,
  runRound,
  restartFromStepKey,
  steps,
  stepProgress,
  artifacts,
  selectedStep,
  durationNowMs,
  onStepClick,
}: TaskStepProgressGraphProps) {
  const { t, locale } = useI18n()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const centeredOnceRef = useRef(false)
  const panCaptureRef = useRef<HTMLElement | null>(null)
  const dragStateRef = useRef({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  })
  const cardPressRef = useRef({ pressed: false, moved: false, x: 0, y: 0 })

  const layout = useMemo(() => computeGraphLayout(steps), [steps])
  const rounds = useMemo(
    () => deriveStepRounds(
      runRound,
      restartFromStepKey,
      steps,
      stepProgress,
      artifacts,
    ),
    [runRound, restartFromStepKey, steps, stepProgress, artifacts],
  )

  const nodes = useMemo<GraphNode[]>(() => steps.map((step, index) => {
    const progress = stepProgress[index]
    const visualState = progress?.visualState ?? 'pending'
    return {
      step,
      index,
      progress,
      visualState,
      round: rounds[index],
      column: layout.columnOf[index],
      row: layout.rowOf[index],
    }
  }), [steps, stepProgress, layout, rounds])

  const columnCount = nodes.reduce((max, node) => Math.max(max, node.column + 1), 1)
  const rowCount = nodes.reduce((max, node) => Math.max(max, node.row + 1), 1)
  const cardWidth = useMemo(() => {
    const available = Math.max(
      0,
      viewport.width
        - GRID_PADDING_X * 2
        - COLUMN_GAP * Math.max(0, columnCount - 1),
    )
    const fitted = columnCount > 0 ? Math.floor(available / columnCount) : CARD_WIDTH_MIN
    return Math.min(CARD_WIDTH_MAX, Math.max(CARD_WIDTH_MIN, fitted || CARD_WIDTH_MIN))
  }, [columnCount, viewport.width])
  const gridWidth = Math.max(
    viewport.width,
    GRID_PADDING_X * 2
      + columnCount * cardWidth
      + COLUMN_GAP * Math.max(0, columnCount - 1),
  )
  const gridHeight = Math.max(GRID_PADDING_Y * 2 + rowCount * ROW_HEIGHT, 160)
  const scaledGridWidth = Math.max(viewport.width, gridWidth * zoom)
  const scaledGridHeight = Math.max(viewport.height, gridHeight * zoom)

  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const geometryRef = useRef({
    gridWidth,
    gridHeight,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  })
  geometryRef.current = {
    gridWidth,
    gridHeight,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  }

  const selectedNode = nodes.find((node) => node.index === selectedStep)
  const activeNode = nodes.find((node) => isActiveState(node.visualState))
  // Selection wins so clicking any card pulls it back to the center.
  const focusNode = selectedNode ?? activeNode ?? nodes[0]
  const currentNode = activeNode

  const selectedRelated = useMemo(() => {
    if (!focusNode) return new Set<number>()
    const related = new Set<number>([focusNode.index])
    const queue = [focusNode.index]
    while (queue.length > 0) {
      const current = queue.shift()!
      layout.dependencies[current]?.forEach((dep) => {
        if (!related.has(dep)) {
          related.add(dep)
          queue.push(dep)
        }
      })
      layout.dependencies.forEach((deps, index) => {
        if (deps.includes(current) && !related.has(index)) {
          related.add(index)
          queue.push(index)
        }
      })
    }
    return related
  }, [focusNode, layout.dependencies])

  const measure = useCallback(() => {
    const surface = surfaceRef.current
    if (!surface) return
    setViewport({ width: surface.clientWidth, height: surface.clientHeight })
  }, [])

  useEffect(() => {
    measure()
    const surface = surfaceRef.current
    const grid = gridRef.current
    if (!surface || !grid) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(surface)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [measure, nodes.length])

  const centerOnIndex = useCallback((index: number | undefined, behavior: ScrollBehavior) => {
    if (index === undefined) return
    const surface = surfaceRef.current
    const grid = gridRef.current
    if (!surface || !grid) return
    const key = steps[index]?.key
    if (key === undefined) return
    let target: HTMLElement | null = null
    grid.querySelectorAll<HTMLElement>('[data-step-key]').forEach((element) => {
      if (!target && element.dataset.stepKey === key) target = element
    })
    const node = target as HTMLElement | null
    if (!node) return
    const currentZoom = zoomRef.current
    const geometry = geometryRef.current
    const scaledWidth = Math.max(geometry.viewportWidth, geometry.gridWidth * currentZoom)
    const scaledHeight = Math.max(geometry.viewportHeight, geometry.gridHeight * currentZoom)
    const maxLeft = Math.max(0, scaledWidth - surface.clientWidth)
    const maxTop = Math.max(0, scaledHeight - surface.clientHeight)
    const left = clampNumber(
      node.offsetLeft * currentZoom + node.offsetWidth * currentZoom / 2 - surface.clientWidth / 2,
      0,
      maxLeft,
    )
    const top = clampNumber(
      node.offsetTop * currentZoom + node.offsetHeight * currentZoom / 2 - surface.clientHeight / 2,
      0,
      maxTop,
    )
    surface.scrollTo({ left, top, behavior })
  }, [steps])

  useEffect(() => {
    if (viewport.width === 0) return
    centerOnIndex(focusNode?.index, centeredOnceRef.current ? 'smooth' : 'auto')
    centeredOnceRef.current = true
  }, [centerOnIndex, focusNode?.index, viewport.width])

  const edges = useMemo<EdgeRoute[]>(() => {
    const routes: EdgeRoute[] = []

    steps.forEach((step, index) => {
      const target = nodeRect(nodes[index], cardWidth)
      layout.dependencies[index]?.forEach((depIndex) => {
        const source = nodeRect(nodes[depIndex], cardWidth)
        const route = routeEdge(source, target)
        const active = selectedRelated.has(index) && selectedRelated.has(depIndex)
        routes.push({
          key: `${steps[depIndex].key}->${step.key}`,
          ...route,
          active,
          flowing: active && (
            isActiveState(nodes[index].visualState)
            || isActiveState(nodes[depIndex].visualState)
          ),
          dashed: layout.dashedDependencies.has(`${depIndex}->${index}`)
            || nodes[index].visualState === 'rework_waiting',
        })
      })
    })
    return routes
  }, [cardWidth, layout.dashedDependencies, layout.dependencies, nodes, selectedRelated, steps])

  const applyZoom = useCallback((
    nextZoom: number,
    anchor?: { contentX: number; contentY: number; screenX: number; screenY: number },
  ) => {
    const surface = surfaceRef.current
    const currentZoom = zoomRef.current
    const clamped = clampZoom(nextZoom)
    if (clamped === currentZoom) return
    let resolvedAnchor = anchor
    if (!resolvedAnchor && surface) {
      resolvedAnchor = {
        contentX: (surface.scrollLeft + surface.clientWidth / 2) / currentZoom,
        contentY: (surface.scrollTop + surface.clientHeight / 2) / currentZoom,
        screenX: surface.clientWidth / 2,
        screenY: surface.clientHeight / 2,
      }
    }
    zoomRef.current = clamped
    setZoom(clamped)
    if (!resolvedAnchor || !surface) return
    const geometry = geometryRef.current
    requestAnimationFrame(() => {
      const activeSurface = surfaceRef.current
      if (!activeSurface) return
      const scaledWidth = Math.max(geometry.viewportWidth, geometry.gridWidth * clamped)
      const scaledHeight = Math.max(geometry.viewportHeight, geometry.gridHeight * clamped)
      activeSurface.scrollLeft = clampNumber(
        resolvedAnchor!.contentX * clamped - resolvedAnchor!.screenX,
        0,
        Math.max(0, scaledWidth - activeSurface.clientWidth),
      )
      activeSurface.scrollTop = clampNumber(
        resolvedAnchor!.contentY * clamped - resolvedAnchor!.screenY,
        0,
        Math.max(0, scaledHeight - activeSurface.clientHeight),
      )
    })
  }, [])

  const zoomBy = useCallback((delta: number) => {
    applyZoom(zoomRef.current + delta)
  }, [applyZoom])

  const setSurfaceScroll = (left: number, top: number) => {
    const surface = surfaceRef.current
    if (!surface) return
    surface.scrollLeft = left
    surface.scrollTop = top
  }

  const beginPan = (
    event: ReactPointerEvent<HTMLElement>,
    captureTarget: HTMLElement,
    card?: HTMLElement | null,
  ) => {
    if (event.button !== 0) return
    const surface = surfaceRef.current
    if (!surface) return
    if (card) {
      cardPressRef.current = {
        pressed: true,
        moved: false,
        x: event.clientX,
        y: event.clientY,
      }
    }
    dragStateRef.current = {
      active: true,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: surface.scrollLeft,
      scrollTop: surface.scrollTop,
    }
    surface.classList.add('is-panning')
    panCaptureRef.current = captureTarget
    captureTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-step-key]')) return
    beginPan(event, event.currentTarget)
  }

  const handleCardPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-step-key]')
    beginPan(event, event.currentTarget, card)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current
    if (!state.active) return
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    const cardPress = cardPressRef.current
    if (cardPress.pressed) {
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) cardPress.moved = true
    }
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) state.moved = true
    setSurfaceScroll(state.scrollLeft - dx, state.scrollTop - dy)
  }

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current
    if (!state.active) return
    state.active = false
    const surface = surfaceRef.current
    surface?.classList.remove('is-panning')
    const captureTarget = panCaptureRef.current
    if (captureTarget?.hasPointerCapture(event.pointerId)) {
      captureTarget.releasePointerCapture(event.pointerId)
    }
    panCaptureRef.current = null
    if (event.type === 'pointercancel') {
      cardPressRef.current = { pressed: false, moved: false, x: 0, y: 0 }
    }
  }

  const handleCardClick = (index: number) => {
    if (dragStateRef.current.moved || cardPressRef.current.moved) {
      dragStateRef.current.moved = false
      cardPressRef.current = { pressed: false, moved: false, x: 0, y: 0 }
      return
    }
    cardPressRef.current = { pressed: false, moved: false, x: 0, y: 0 }
    onStepClick(index)
  }

  return (
    <div className="task-step-progress">
      <div className="task-step-progress-header">
        <span className="task-step-progress-title">
          {t('taskDetail.progress')}
        </span>
        <span className="task-step-progress-header-focus">
          {currentNode && (
            <span
              className="task-step-progress-focus"
              data-testid="task-step-progress-current-step"
              title={t('taskDetail.currentStepFocus', { step: currentNode.step.label })}
            >
              <Icon name="crosshair" size={11} strokeWidth={2.2} />
              <span className="task-step-progress-focus-text">
                {t('taskDetail.currentStepFocus', { step: currentNode.step.label })}
              </span>
            </span>
          )}
          {runRound > 1 && (
            <span className="task-step-progress-round">
              {t('taskDetail.runRound', { round: runRound })}
            </span>
          )}
        </span>
        <span className="task-step-progress-zoom">
          <button
            type="button"
            data-testid="task-step-progress-zoom-out"
            aria-label={t('taskDetail.zoomOut')}
            disabled={zoom <= ZOOM_MIN}
            onClick={() => zoomBy(-ZOOM_STEP)}
          >
            <Icon name="minus" size={11} strokeWidth={2.4} />
          </button>
          <button
            type="button"
            className="task-step-progress-zoom-level"
            data-testid="task-step-progress-zoom-reset"
            aria-label={t('taskDetail.zoomReset')}
            onClick={() => applyZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            data-testid="task-step-progress-zoom-in"
            aria-label={t('taskDetail.zoomIn')}
            disabled={zoom >= ZOOM_MAX}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <Icon name="plus" size={11} strokeWidth={2.4} />
          </button>
        </span>
      </div>
      <div
        ref={surfaceRef}
        className="task-step-progress-surface"
        data-testid="task-step-progress-surface"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div
          className="task-step-progress-zoom-layer"
          style={{
            width: scaledGridWidth,
            height: scaledGridHeight,
          }}
        >
          <div
            ref={gridRef}
            className="task-step-progress-grid"
            style={{
              width: gridWidth,
              height: gridHeight,
              transform: `scale(${zoom})`,
            }}
          >
            <svg
              className="task-step-progress-edges"
              aria-hidden="true"
              width={gridWidth}
              height={gridHeight}
              viewBox={`0 0 ${gridWidth} ${gridHeight}`}
              preserveAspectRatio="none"
            >
              {edges.map((edge) => (
                <g key={edge.key}>
                  <path
                    className={[
                      'task-step-progress-edge',
                      edge.active ? 'is-active' : '',
                      edge.flowing ? 'is-flowing' : '',
                      edge.dashed ? 'is-dashed' : '',
                      edge.dashed ? 'is-rework' : '',
                    ].filter(Boolean).join(' ')}
                    d={edge.path}
                  />
                  <circle
                    className={[
                      'task-step-progress-port',
                      edge.active ? 'is-active' : '',
                      edge.dashed ? 'is-dashed' : '',
                      edge.dashed ? 'is-rework' : '',
                    ].filter(Boolean).join(' ')}
                    cx={edge.startX}
                    cy={edge.startY}
                    r="2.9"
                  />
                  <circle
                    className={[
                      'task-step-progress-port',
                      edge.active ? 'is-active' : '',
                      edge.dashed ? 'is-dashed' : '',
                      edge.dashed ? 'is-rework' : '',
                    ].filter(Boolean).join(' ')}
                    cx={edge.endX}
                    cy={edge.endY}
                    r="2.9"
                  />
                </g>
              ))}
            </svg>
            {nodes.map((node) => {
            const progress = node.progress
            const finishedDuration = progress?.ended_at
              ? formatDurationBetween(progress?.started_at, progress.ended_at, t)
              : null
            const startedAtMs =
              toMilliseconds(progress?.started_at)
              ?? toMilliseconds(progress?.created_at)
              ?? Date.now()
            const updatedAtMs = toMilliseconds(progress?.updated_at) ?? Date.now()
            const isDurationLive =
              taskStatus === 'running'
              || isActiveState(node.visualState)
              || taskStatus === 'paused'
            const activeDuration = isActiveState(node.visualState) && progress?.started_at
              ? formatDurationBetween(
                  progress.started_at,
                  isDurationLive ? durationNowMs : updatedAtMs,
                  t,
                )
              : null
            const duration = finishedDuration ?? activeDuration
            const startedAt = progress?.started_at
              ? new Date(startedAtMs).toLocaleTimeString(locale, {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : null
            const isSelected = node.index === selectedStep
            const isCurrentStep = node.index === currentNode?.index
            const dimmed = !selectedRelated.has(node.index)
            const badgeState = node.visualState === 'current' && taskStatus === 'paused'
              ? 'awaiting_review'
              : node.visualState

              return (
                <div
                  key={node.step.key}
                  data-step-key={node.step.key}
                  className="task-step-progress-node"
                  style={{
                    left: GRID_PADDING_X + node.column * (cardWidth + COLUMN_GAP),
                    top: GRID_PADDING_Y + node.row * ROW_HEIGHT,
                    width: cardWidth,
                  }}
                >
                <button
                  type="button"
                  className={[
                    'task-step-progress-card',
                    `is-${badgeState}`,
                    isSelected ? 'is-selected' : '',
                    dimmed ? 'is-dimmed' : '',
                  ].filter(Boolean).join(' ')}
                  data-state={badgeState}
                  aria-pressed={isSelected}
                  aria-label={t('taskDetail.viewStepMessagesAria', {
                    step: node.step.label,
                  })}
                  onPointerDown={handleCardPointerDown}
                  onClick={() => handleCardClick(node.index)}
                >
                  <div className="task-step-progress-card-head">
                    <MarqueeText
                      text={node.step.label}
                      className="task-step-progress-name"
                    />
                    <span className="task-step-progress-card-tags">
                      {isCurrentStep && (
                        <span
                          className="task-step-progress-current-tag"
                          data-testid="task-step-progress-current-tag"
                        >
                          {t('status.current')}
                        </span>
                      )}
                      <span className="task-step-progress-round-tag">
                        {t('taskDetail.runRoundShort', { round: node.round })}
                      </span>
                    </span>
                  </div>
                  <div className="task-step-progress-card-body">
                    <span className="task-step-progress-status">
                      <span
                        className={`task-step-progress-status-icon${isActiveState(node.visualState) ? ' is-active' : ''}`}
                      >
                        <Icon
                          name={STATE_ICONS[badgeState]}
                          size={8}
                          className={[
                            'task-step-progress-status-icon-glyph',
                            isSpinningState(badgeState) ? 'is-spinning' : '',
                          ].filter(Boolean).join(' ')}
                        />
                      </span>
                      <span className="task-step-progress-status-text">
                        {t(STATE_LABEL_KEYS[badgeState])}
                      </span>
                    </span>
                    <span className="task-step-progress-meta">
                      {startedAt && <span>{startedAt}</span>}
                      <span>{duration ?? t('status.pending')}</span>
                    </span>
                  </div>
                </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
