import type { Root, Element, RootContent } from 'hast'

/** Wrap visible prose only; code, diagrams and image labels stay untouched. */
export default function rehypeStreamReveal() {
  return (tree: Root) => {
    const visit = (parent: Root | Element) => {
      parent.children = parent.children.map((child: RootContent) => {
        if (child.type === 'element') {
          if (!['pre', 'code', 'svg', 'math'].includes(child.tagName)) visit(child)
        } else if (child.type === 'text' && child.value.trim()) {
          return {
            type: 'element', tagName: 'stream-reveal-text',
            properties: { text: child.value }, children: [],
          } as Element
        }
        return child
      }) as typeof parent.children
    }
    visit(tree)
  }
}
