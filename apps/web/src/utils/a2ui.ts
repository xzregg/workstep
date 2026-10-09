import { gatewayResourceUrl } from './gatewayWorkspacePath'
import type {
  A2uiClientAction,
  A2uiMessage,
  UpdateComponentsMessage,
} from '@a2ui/web_core/v0_9'

/* ══════════════════════════════════════════
   A2UI (Agent-to-User Interface) helpers.

   Display-only integration: the LLM writes A2UI v0.9/v0.9.1 JSONL messages
   inside a complete ```a2ui fenced code block in the message content.
   Complete fences are extracted and rendered as UI; incomplete (streaming)
   fences stay plain text until they close.
   ══════════════════════════════════════════ */

const A2UI_FENCE = /^```a2ui[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?\n?/gm

// Non-global copy for `test` (avoids lastIndex statefulness of the /g regex).
const A2UI_FENCE_PRESENT = /^```a2ui[ \t]*\r?\n[\s\S]*?^```[ \t]*\r?\n?/m

// During streaming, the closing fence may not have arrived yet. This pattern
// removes the protocol tail from visible message text without changing the
// complete-fence parser used for rendering and copying.
const A2UI_OPEN_FENCE = /^```a2ui[ \t]*\r?\n[\s\S]*$/m

const A2UI_KEYS = [
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
] as const

function isA2uiMessage(value: unknown): value is A2uiMessage {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (obj.version !== 'v0.9' && obj.version !== 'v0.9.1') return false
  return A2UI_KEYS.filter(
    (key) => obj[key] !== null && typeof obj[key] === 'object',
  ).length === 1
}

function parseFenceBody(body: string): A2uiMessage[] {
  const messages: A2uiMessage[] = []
  // Accumulate lines so both single-line JSONL and pretty-printed multi-line
  // JSON objects inside the fence are parsed; non-JSON lines are dropped.
  let buffer = ''
  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed && !buffer) continue
    buffer += (buffer ? '\n' : '') + rawLine
    try {
      const parsed = JSON.parse(buffer) as unknown
      if (isA2uiMessage(parsed)) messages.push(parsed)
      buffer = ''
    } catch {
      // Incomplete JSON object — keep accumulating; drop stray non-JSON text.
      if (!buffer.trim().startsWith('{')) buffer = ''
    }
  }
  return messages
}

/** Extract complete ```a2ui fences and parse each line as an A2UI message. */
export function extractA2uiMessages(content: string): A2uiMessage[] {
  const messages: A2uiMessage[] = []
  for (const match of content.matchAll(A2UI_FENCE)) {
    messages.push(...parseFenceBody(match[1] ?? ''))
  }
  return messages
}

/** Remove complete ```a2ui fences from text used for markdown/copy. */
export function stripA2uiBlocks(content: string): string {
  return content.replace(A2UI_FENCE, '')
}

/** Hide complete and currently-streaming A2UI protocol blocks from markdown. */
export function stripA2uiBlocksForDisplay(content: string): string {
  return stripA2uiBlocks(content).replace(A2UI_OPEN_FENCE, '')
}

const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?\n?/gim

/** Hide internal A2UI and workflow-canvas payloads from assistant bubbles. */
export function stripAssistantPayloadsForDisplay(content: string): string {
  let removedCanvas = false
  let visible = stripA2uiBlocksForDisplay(content).replace(
    JSON_FENCE,
    (block, body: string) => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>
        if (!Array.isArray(parsed.nodes)) return block
        if (parsed.connections !== undefined && !Array.isArray(parsed.connections)) return block
        removedCanvas = true
        return ''
      } catch {
        return block
      }
    },
  )
  if (removedCanvas) {
    visible = visible.replace(/^.*(?:完整画布|画布).*JSON.*\r?\n(?:\r?\n)?/gim, '')
    visible = visible.replace(/\n{3,}/g, '\n\n')
  }
  return visible
}

/** True when content contains at least one complete ```a2ui fence. */
export function hasA2uiBlocks(content: string): boolean {
  return A2UI_FENCE_PRESENT.test(content)
}

/** Legacy internal apply actions were persisted as user-visible chat text. */
export function isHiddenA2uiActionMessage(content: string): boolean {
  return /^apply_flow\s*[:：]\s*\{\s*"proposal"\s*:\s*\d+\s*\}\s*$/i
    .test(content.trim())
}

/** Values passed to the localized chat message for a submitted A2UI action. */
export function a2uiActionMessageParams(action: A2uiClientAction): {
  name: string
  context: string
} {
  const context = action.context ?? {}
  if (action.name === 'apply_flow' && typeof context.stepsJson !== 'string') {
    const proposal = context.proposal
    return {
      name: '选择流程方案',
      context: proposal === undefined ? '' : `：第 ${proposal} 个方案`,
    }
  }
  const isFormSubmission = /form answers|submit(?:[_ -](?:form|clarification|brief))?|discovery/i
    .test(action.name)
  if (isFormSubmission) {
    const contextAnswers = Object.entries(context)
    const embeddedAnswers = action.name.split(/\r?\n/)
      .map((line) => line.match(/^\s*-\s*(.+?)\s*:\s*(.*)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1], match[2]] as const)
    const answers = (contextAnswers.length > 0 ? contextAnswers : embeddedAnswers)
      .flatMap(([question, rawValue]) => {
        const value = Array.isArray(rawValue)
          ? rawValue.filter((item) => item !== null && item !== undefined).join('、')
          : typeof rawValue === 'string'
            ? rawValue
            : rawValue === null || rawValue === undefined
              ? ''
              : String(rawValue)
        if (!value.trim() || /^\(skipped\)$/i.test(value.trim())) return []
        return [`${question}：${value}`]
      })
    return {
      name: '已提交表单',
      context: answers.length > 0 ? `：${answers.join('；')}` : '',
    }
  }
  return {
    name: action.name,
    context: Object.keys(context).length > 0
      ? `：${JSON.stringify(context)}`
      : '',
  }
}

interface A2uiFlowProposalLike {
  id?: string
  steps: unknown
  autoApply?: boolean
}

/** Resolve an apply-flow action, preferring its historical self-contained payload. */
export function resolveA2uiFlowSteps(
  action: A2uiClientAction,
  proposals: A2uiFlowProposalLike[],
): { steps: unknown; proposalId: string } | undefined {
  if (action.name !== 'apply_flow') return undefined
  const context = action.context ?? {}
  if (typeof context.stepsJson === 'string') {
    try {
      const steps = JSON.parse(context.stepsJson) as unknown
      if (steps && typeof steps === 'object') {
        return {
          steps,
          proposalId: typeof context.proposalId === 'string'
            ? context.proposalId
            : '',
        }
      }
    } catch {
      // Fall back to the live proposal batch below.
    }
  }

  const rawIndex = context.proposal
  const index = typeof rawIndex === 'number'
    ? rawIndex - 1
    : typeof rawIndex === 'string'
      ? Number.parseInt(rawIndex, 10) - 1
      : -1
  const proposal = Number.isNaN(index) ? undefined : proposals[index]
  return proposal
    ? { steps: proposal.steps, proposalId: proposal.id ?? '' }
    : undefined
}

export function pendingAutoApplyProposal<T extends A2uiFlowProposalLike>(
  proposals: T[],
  appliedProposalId: string | null,
): T | undefined {
  return proposals.find(
    (proposal) => proposal.autoApply === true
      && (proposal.id ?? '') !== appliedProposalId,
  )
}

const UPLOAD_RELATIVE = /^(?:[^/]+\/)?\.workstep\/uploads\/([^/?#]+)$/

/**
 * Rewrite `Image.url` project-relative upload paths
 * (`.workstep/uploads/<uuid>.<ext>`, including the legacy project-name prefix)
 * to the serving endpoint,
 * mirroring MarkdownMessage's mapping. Literal string URLs only.
 */
export function normalizeA2uiMessages(
  messages: A2uiMessage[],
  projectId?: string,
): A2uiMessage[] {
  if (!projectId) return messages
  return messages.map((message) => {
    if (!('updateComponents' in message)) return message
    return {
      ...message,
      updateComponents: {
        ...message.updateComponents,
        components: message.updateComponents.components.map((component) => {
          if (
            !component
            || typeof component !== 'object'
            || (component as { component?: unknown }).component !== 'Image'
          ) {
            return component
          }
          const url = (component as { url?: unknown }).url
          if (typeof url !== 'string') return component
          const match = url.match(UPLOAD_RELATIVE)
          if (!match) return component
          return {
            ...component,
            url: gatewayResourceUrl(`/api/fs/serve/${encodeURIComponent(match[1])}?project_id=${encodeURIComponent(projectId)}`),
          }
        }),
      },
    }
  })
}

/**
 * Repair common model-produced aliases before catalog validation. This stays
 * in the shared A2UI renderer so every LLM message surface behaves the same.
 */
export function normalizeA2uiInteractiveComponents(
  messages: A2uiMessage[],
): A2uiMessage[] {
  const usedIds = new Set<string>()
  for (const message of messages) {
    if (!('updateComponents' in message)) continue
    for (const component of message.updateComponents.components) {
      const id = (component as { id?: unknown }).id
      if (typeof id === 'string') usedIds.add(id)
    }
  }

  const uniqueId = (base: string) => {
    let id = base
    let suffix = 2
    while (usedIds.has(id)) id = `${base}-${suffix++}`
    usedIds.add(id)
    return id
  }

  return messages.map((message) => {
    if (!('updateComponents' in message)) return message
    const additions: Array<Record<string, unknown>> = []
    const components = message.updateComponents.components.map((component) => {
      if (!component || typeof component !== 'object') return component
      const next = { ...component } as Record<string, unknown>

      if (next.component === 'ChoicePicker' && next.variant === undefined) {
        if (next.multipleSelection === true) next.variant = 'multipleSelection'
        else if (next.mutuallyExclusive === true) next.variant = 'mutuallyExclusive'
        delete next.multipleSelection
        delete next.mutuallyExclusive
      }

      if (next.component === 'TextField') {
        if (typeof next.label !== 'string') {
          next.label = typeof next.placeholder === 'string' ? next.placeholder : ''
        }
        if (next.variant === undefined && next.multiline === true) {
          next.variant = 'longText'
        }
        delete next.placeholder
        delete next.multiline
      }

      if (next.component === 'Button' && typeof next.child !== 'string') {
        const text = typeof next.label === 'string'
          ? next.label
          : typeof next.text === 'string'
            ? next.text
            : ''
        if (text) {
          const componentId = typeof next.id === 'string' ? next.id : 'button'
          const childId = uniqueId(`${componentId}-label`)
          next.child = childId
          additions.push({ component: 'Text', id: childId, text })
        }
        delete next.label
        delete next.text
      }

      return next as typeof component
    })

    return {
      ...message,
      updateComponents: {
        ...message.updateComponents,
        components: [...components, ...additions],
      },
    } as A2uiMessage
  })
}

const A2UI_ROOT_ID = 'root'

function collectChildIds(
  components: UpdateComponentsMessage['updateComponents']['components'],
): Set<string> {
  const childIds = new Set<string>()
  for (const component of components) {
    const children = (component as { children?: unknown }).children
    if (!Array.isArray(children)) continue
    for (const child of children) {
      if (typeof child === 'string') childIds.add(child)
    }
  }
  return childIds
}

/**
 * A2UI renders a surface from its root component (`id: 'root'`). Some models
 * send `createSurface` + `updateComponents` without an explicit root, which
 * makes the renderer fall back to its "[Loading root...]" placeholder.
 * Inject an implicit `Column` root wrapping the top-level components (ids
 * that are not referenced as a child of any other component) for each surface
 * that has components but no root. Surfaces with no components stay unchanged.
 */
export function ensureA2uiRoots(messages: A2uiMessage[]): A2uiMessage[] {
  const updates = messages.filter(
    (message): message is UpdateComponentsMessage =>
      'updateComponents' in message,
  )
  if (updates.length === 0) return messages

  const componentsBySurface = new Map<
    string,
    UpdateComponentsMessage['updateComponents']['components']
  >()
  for (const message of updates) {
    const { surfaceId, components } = message.updateComponents
    const existing = componentsBySurface.get(surfaceId) ?? []
    componentsBySurface.set(surfaceId, [...existing, ...components])
  }

  const rootsBySurface = new Map<string, Array<Record<string, unknown>>>()
  for (const [surfaceId, components] of componentsBySurface) {
    if (components.length === 0) continue
    if (components.some((c) => c && typeof c === 'object' && (c as { id?: unknown }).id === A2UI_ROOT_ID)) {
      continue
    }
    const childIds = collectChildIds(components)
    const topLevel = components
      .map((c) => (c as { id?: unknown }).id)
      .filter((id): id is string => typeof id === 'string' && !childIds.has(id))
    rootsBySurface.set(surfaceId, [
      { component: 'Column', id: A2UI_ROOT_ID, children: topLevel },
    ])
  }
  if (rootsBySurface.size === 0) return messages

  return messages.map((message) => {
    if (!('updateComponents' in message)) return message
    const extra = rootsBySurface.get(message.updateComponents.surfaceId)
    if (!extra) return message
    return {
      ...message,
      updateComponents: {
        ...message.updateComponents,
        components: [...extra, ...message.updateComponents.components],
      },
    }
  })
}

/**
 * Minimal adapter over an A2UI surface's component model so the reference
 * reconciliation below stays pure and unit-testable.
 */
export interface A2uiReferenceStore {
  /** All component ids currently present on the surface. */
  componentIds(): string[]
  /** Raw properties for a component (without the component/id envelope). */
  getProperties(id: string): Record<string, unknown> | undefined
  setProperties(id: string, props: Record<string, unknown>): void
  /** Add a Text component with the given id/text. */
  addText(id: string, text: string): void
}

/**
 * A2UI containers reference children by id (`children` arrays, `child` strings,
 * `tabs[].child`). The library renders missing references as "[Loading x...]"
 * placeholders. Ensure every referenced id resolves: for references that point
 * to a non-existent component, synthesize a Text component whose text is the
 * reference itself (a model may write a Button child label directly), so the
 * surface never shows the library's placeholder.
 */
export function reconcileA2uiReferences(store: A2uiReferenceStore): void {
  const existing = new Set(store.componentIds())
  const missing = new Map<string, string>()

  const touch = (ref: unknown) => {
    if (typeof ref === 'string' && ref && !existing.has(ref)) {
      missing.set(ref, ref)
    }
  }

  for (const id of store.componentIds()) {
    const props = store.getProperties(id)
    if (!props) continue
    const next: Record<string, unknown> = { ...props }

    const children = next.children
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === 'string') {
          touch(child)
        } else if (child && typeof child === 'object') {
          const ref = child as { id?: unknown }
          if (typeof ref.id === 'string') touch(ref.id)
        }
      }
    }

    if (typeof next.child === 'string') touch(next.child)

    const tabs = next.tabs
    if (Array.isArray(tabs)) {
      for (const tab of tabs) {
        if (tab && typeof tab === 'object') {
          const ref = tab as { child?: unknown }
          if (typeof ref.child === 'string') touch(ref.child)
        }
      }
    }

    store.setProperties(id, next)
  }

  for (const [refId, text] of missing) {
    if (existing.has(refId)) continue
    store.addText(refId, text)
    existing.add(refId)
  }
}

/**
 * Split every `updateComponents` message into one message per component.
 * The MessageProcessor validates a whole message up-front and drops it on the
 * first invalid component; splitting isolates failures so a single bad
 * component degrades to that component only instead of losing the surface.
 */
export function splitA2uiUpdateComponents(messages: A2uiMessage[]): A2uiMessage[] {
  const split: A2uiMessage[] = []
  for (const message of messages) {
    if (!('updateComponents' in message)) {
      split.push(message)
      continue
    }
    const { surfaceId, components } = message.updateComponents
    for (const component of components) {
      split.push({
        ...message,
        updateComponents: { surfaceId, components: [component] },
      })
    }
  }
  return split
}

/* ══════════════════════════════════════════
   Interactive state binding.

   A2UI's GenericBinder only writes component state back through ``{ path }``
   data bindings: for a static literal ``value`` the generated ``setValue``
   is a no-op, so interactive components (ChoicePicker/TextField/CheckBox/
   Slider/...) never react to clicks or typing. Converting static DYNAMIC
   props into data-model bindings seeded with the original literal keeps the
   display identical while local interaction updates the bound model and
   re-renders.
   ══════════════════════════════════════════ */

import { scrapeSchemaBehavior } from '@a2ui/web_core/v0_9'
import type { SurfaceModel } from '@a2ui/web_core/v0_9'
import type { z } from 'zod'

export function bindStaticInteractiveValues(surface: SurfaceModel) {
  for (const [id, model] of Array.from(surface.componentsModel.entries)) {
    const api = surface.catalog.components.get(model.type)
    if (!api) continue
    const behavior = scrapeSchemaBehavior(api.schema as z.ZodTypeAny)
    if (behavior.type !== 'OBJECT') continue
    const props = model.properties as Record<string, unknown>
    for (const [field, fieldBehavior] of Object.entries(behavior.shape ?? {})) {
      if (fieldBehavior.type !== 'DYNAMIC') continue
      const value = props[field]
      if (value === undefined || value === null) continue
      // Already a data binding or function call - leave it untouched.
      if (typeof value === 'object' && !Array.isArray(value)
        && ('path' in value || 'call' in value)) continue
      const path = `/a2ui/${surface.id}/${id}/${field}`
      surface.dataModel.set(path, value)
      model.properties = { ...props, [field]: { path } }
    }
  }
}
