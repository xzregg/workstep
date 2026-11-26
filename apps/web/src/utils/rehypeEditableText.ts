import type { Element, Root } from 'hast'

/** Source positions belong to the frozen Markdown tree, never to rendered HTML. */
export function rehypeEditableText() {
  return (tree: Root) => {
    let count = 0
    const visit = (parent: Root | Element) => {
      parent.children = parent.children.map(child => {
        if (child.type === 'element' && !['pre', 'code', 'svg', 'math'].includes(child.tagName)) visit(child)
        if (child.type !== 'text' || !child.value.trim() || child.position?.start.offset === undefined || child.position.end.offset === undefined) return child
        count++
        return { type: 'element', tagName: 'editable-markdown-text', properties: {
          text: child.value, sourceStart: child.position.start.offset, sourceEnd: child.position.end.offset,
        }, children: [] } as Element
      }) as typeof parent.children
    }
    visit(tree)
    // Empty and image-only messages still need an insertion point in the preview.
    if (!count) tree.children.push({ type: 'element', tagName: 'p', properties: {}, children: [{
      type: 'element', tagName: 'editable-markdown-text', properties: {
        text: '', sourceStart: tree.position?.end.offset ?? 0, sourceEnd: tree.position?.end.offset ?? 0,
      }, children: [],
    }] })
  }
}

