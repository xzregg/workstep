import { useMemo } from 'react'
import {
  Catalog,
  ComponentModel,
  MessageProcessor,
  type A2uiClientAction,
  type A2uiMessage as A2uiMessagePayload,
} from '@a2ui/web_core/v0_9'
import { A2uiSurface, MarkdownContext, basicCatalog } from '@a2ui/react/v0_9'
import type { z } from 'zod'
import { renderMarkdown } from '@a2ui/markdown-it'
import {
  bindStaticInteractiveValues,
  ensureA2uiRoots,
  extractA2uiMessages,
  hasA2uiBlocks,
  normalizeA2uiInteractiveComponents,
  normalizeA2uiMessages,
  reconcileA2uiReferences,
  splitA2uiUpdateComponents,
} from '../utils/a2ui'
import '../styles/a2ui-v09.css'

/* ══════════════════════════════════════════
   A2uiMessage — renders A2UI v0.9/v0.9.1 payloads embedded in assistant
   message content (complete ```a2ui fences) as interactive UI.

   When ``onAction`` is provided, user clicks dispatch client actions to it
   (e.g. applying a flow proposal); without it the surface stays display-only.

   Rendering is intentionally tolerant of imperfect model payloads:
   - component schemas are stripped of unknown keys instead of rejecting them,
   - unknown component types degrade to Text,
   - dangling child references resolve to synthesized Text components,
   so the library's "[Loading x...]" placeholders never appear.
   ══════════════════════════════════════════ */

/**
 * Basic catalog with schemas downgraded from strict to strip: extra keys in
 * model payloads are dropped instead of failing validation, while the schema
 * shape is preserved so the generic binder still resolves value/action/child
 * behaviors exactly like the official catalog.
 */
const TOLERANT_CATALOG = new Catalog(
  basicCatalog.id,
  Array.from(basicCatalog.components.values()).map((api) => ({
    ...api,
    schema: (api.schema as z.ZodObject<z.ZodRawShape>).strip(),
  })),
  Array.from(basicCatalog.functions.values()),
  basicCatalog.themeSchema,
)

export default function A2uiMessage({
  content,
  messages,
  projectId,
  onAction,
}: {
  content: string
  /** Store 累积的 A2UI 载荷（``CUSTOM a2ui.surface`` 事件），优先于 fence 解析。 */
  messages?: Record<string, unknown>[]
  projectId?: string
  /** Receives user-initiated component actions (e.g. proposal buttons). */
  onAction?: (action: A2uiClientAction) => void
}) {
  const surfaces = useMemo(() => {
    const payloads = (messages && messages.length > 0)
      ? messages as unknown as A2uiMessagePayload[]
      : hasA2uiBlocks(content)
        ? extractA2uiMessages(content)
        : []
    if (payloads.length === 0) return []
    const normalized = ensureA2uiRoots(
      normalizeA2uiInteractiveComponents(
        normalizeA2uiMessages(payloads, projectId),
      ).map((message) => (
        // Best-effort rendering: force the basic catalog so any catalogId works.
        'createSurface' in message
          ? {
              ...message,
              createSurface: {
                ...message.createSurface,
                catalogId: basicCatalog.id,
              },
            }
          : message
      )),
    )
    if (normalized.length === 0) return []
    const processor = new MessageProcessor(
      [TOLERANT_CATALOG],
      onAction,
      { version: 'v0.9.1' },
    )
    // Components are processed one per message so a single invalid component
    // degrades to itself instead of dropping the whole updateComponents batch.
    // Remaining irrecoverable messages (missing required props, unknown
    // surface, duplicate surface) are skipped so one malformed payload never
    // crashes the whole conversation.
    for (const message of splitA2uiUpdateComponents(normalized)) {
      try {
        processor.processMessages([message])
      } catch {
        // Ignore invalid A2UI message.
      }
    }
    return Array.from(processor.model.surfacesMap.values())
      .map((surface) => {
        // Unknown component types would render as red "Unknown component: x".
        // Degrade them to a Text carrying whatever string prop is available.
        for (const [id, model] of Array.from(surface.componentsModel.entries)) {
          if (surface.catalog.components.get(model.type)) continue
          const props = model.properties
          const text = typeof props.title === 'string' ? props.title
            : typeof props.text === 'string' ? props.text
            : typeof props.label === 'string' ? props.label
            : typeof props.child === 'string' ? props.child
            : ''
          surface.componentsModel.removeComponent(id)
          if (text.trim()) {
            surface.componentsModel.addComponent(
              new ComponentModel(id, 'Text', { text }),
            )
          }
        }
        // Synthesize Text components for dangling child references so the
        // library's "[Loading x...]" placeholders never appear.
        reconcileA2uiReferences({
          componentIds: () => Array.from(surface.componentsModel.entries).map(([id]) => id),
          getProperties: (id) => surface.componentsModel.get(id)?.properties,
          setProperties: (id, props) => {
            const model = surface.componentsModel.get(id)
            if (model) model.properties = props
          },
          addText: (id, text) => surface.componentsModel.addComponent(
            new ComponentModel(id, 'Text', { text }),
          ),
        })
        // Static DYNAMIC props get bound to the data model so interactive
        // controls (ChoicePicker/TextField/CheckBox/Slider/...) respond to
        // clicks and input instead of being read-only.
        bindStaticInteractiveValues(surface)
        return surface
      })
      // Skip surfaces that produced no components (e.g. a bare createSurface),
      // so the library's "[Loading root...]" placeholder never shows.
      .filter((surface) => {
        for (const _ of surface.componentsModel.entries) return true
        return false
      })
  }, [content, messages, projectId, onAction])

  if (surfaces.length === 0) return null

  return (
    <div className="a2ui-message">
      <MarkdownContext.Provider value={renderMarkdown}>
        {surfaces.map((surface) => (
          <A2uiSurface key={surface.id} surface={surface} />
        ))}
      </MarkdownContext.Provider>
    </div>
  )
}
