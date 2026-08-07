import type { A2uiMessage } from '@a2ui/web_core/v0_9'

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

/** True when content contains at least one complete ```a2ui fence. */
export function hasA2uiBlocks(content: string): boolean {
  return A2UI_FENCE_PRESENT.test(content)
}

const UPLOAD_RELATIVE = /^[^/]+\/\.workstep\/uploads\/([^/?#]+)$/

/**
 * Rewrite `Image.url` project-relative upload paths
 * (`项目名/.workstep/uploads/<uuid>.<ext>`) to the serving endpoint,
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
            url: `/api/fs/serve/${encodeURIComponent(match[1])}?project_id=${encodeURIComponent(projectId)}`,
          }
        }),
      },
    }
  })
}
