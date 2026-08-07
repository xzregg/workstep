import { useMemo } from 'react'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import { A2uiSurface, MarkdownContext, basicCatalog } from '@a2ui/react/v0_9'
import { renderMarkdown } from '@a2ui/markdown-it'
import {
  extractA2uiMessages,
  hasA2uiBlocks,
  normalizeA2uiMessages,
} from '../utils/a2ui'
import '../styles/a2ui-v09.css'

/* ══════════════════════════════════════════
   A2uiMessage — renders A2UI v0.9/v0.9.1 payloads embedded in assistant
   message content (complete ```a2ui fences) as interactive-looking UI.

   Display-only: the MessageProcessor action handler is a no-op, so buttons
   and forms only mutate the in-memory surface state of this message.
   ══════════════════════════════════════════ */

export default function A2uiMessage({
  content,
  projectId,
}: {
  content: string
  projectId?: string
}) {
  const surfaces = useMemo(() => {
    if (!hasA2uiBlocks(content)) return []
    const messages = normalizeA2uiMessages(
      extractA2uiMessages(content),
      projectId,
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
    ))
    if (messages.length === 0) return []
    const processor = new MessageProcessor(
      [basicCatalog],
      // Display-only: suppress action dispatch until a backend hook exists.
      undefined,
      { version: 'v0.9.1' },
    )
    // The processor validates strictly and throws on invalid messages
    // (unknown catalog, duplicate surface, schema violations). Skip bad
    // messages so one malformed payload degrades to partial/raw rendering
    // instead of crashing the whole conversation.
    for (const message of messages) {
      try {
        processor.processMessages([message])
      } catch {
        // Ignore invalid A2UI message.
      }
    }
    return Array.from(processor.model.surfacesMap.values())
  }, [content, projectId])

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
