import type { Root, Element, RootContent } from 'hast'

// Bound animation work across the message, not just within each text node.
// A large burst may contain hundreds of paragraphs and inline fragments.
export const REVEAL_WINDOW_CHARS = 32

/** Wrap visible prose only; code, diagrams and image labels stay untouched. */
export default function rehypeStreamReveal() {
  return (tree: Root) => {
    const tailStart = Math.max(0, (tree.position?.end.offset ?? 0) - REVEAL_WINDOW_CHARS)
    const visit = (parent: Root | Element) => {
      parent.children = parent.children.map((child: RootContent) => {
        if (child.type === 'element') {
          if (!['pre', 'code', 'svg', 'math'].includes(child.tagName)) visit(child)
        } else if (child.type === 'text' && child.value.trim()) {
          return {
            type: 'element', tagName: 'stream-reveal-text',
            properties: {
              text: child.value,
              endOffset: child.position?.end.offset ?? 0,
              animate: (child.position?.end.offset ?? 0) > tailStart,
            }, children: [],
          } as Element
        }
        return child
      }) as typeof parent.children
    }
    visit(tree)
  }
}
