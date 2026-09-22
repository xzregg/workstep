/* ══════════════════════════════════════════
   Composer auto-resize helper.

   The chat composer grows its textareas to fit
   the content. Measuring with height:auto
   momentarily collapses the content, which makes
   the browser clamp the scrollable container's
   scrollTop to 0 — visible as the composer jumping
   to the top while typing. Both offsets are
   captured and restored so typing (including IME
   composition) never moves the scrollbar.
   ══════════════════════════════════════════ */

/** Selector of the composer's scrollable body. */
export const COMPOSER_EDITOR_SELECTOR = '.chat-input-editor'

/** Resize `element` to its content while preserving the composer scroll offset. */
export function resizeComposerTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return
  const scroller = element.closest<HTMLElement>(COMPOSER_EDITOR_SELECTOR)
  const scrollerTop = scroller?.scrollTop ?? 0
  const elementTop = element.scrollTop
  element.style.height = 'auto'
  element.style.height = `${element.scrollHeight}px`
  element.scrollTop = elementTop
  if (scroller) scroller.scrollTop = scrollerTop
}
