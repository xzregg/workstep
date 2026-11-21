import type { Element, Root } from 'hast'

const unresolvedWebCitation = /\uE200cite(?:\uE202turn\d+[a-z]+\d+)+\uE201/g
const citationPrefix = '\uE200cite'
const incompleteReferences = /^(?:turn\d+[a-z]+\d+\uE202)*(?:t|tu|tur|turn(?:\d+(?:[a-z]+\d*)?)?)?$/

export function incompleteWebCitationAtEnd(content: string): string | undefined {
  if (!/[a-z\d\uE200\uE202]/.test(content.at(-1) ?? '')) return
  const start = content.lastIndexOf('\uE200')
  if (start === -1) return
  const tail = content.slice(start)
  if (citationPrefix.startsWith(tail)) return tail
  if (tail.startsWith(`${citationPrefix}\uE202`) && incompleteReferences.test(tail.slice(citationPrefix.length + 1))) return tail
}

export default function rehypeWebCitations(incompleteTail?: string) {
  return (tree: Root) => {
    const endOffset = tree.position?.end.offset
    const visit = (parent: Root | Element) => {
      for (const child of parent.children) {
        if (child.type === 'text' && child.value.includes('\uE200')) {
          if (incompleteTail && child.position?.end.offset === endOffset && child.value.endsWith(incompleteTail)) {
            child.value = child.value.slice(0, -incompleteTail.length)
          }
          child.value = child.value.replace(unresolvedWebCitation, '')
        } else if (child.type === 'element' && child.tagName !== 'pre' && child.tagName !== 'code') {
          visit(child)
        }
      }
    }
    visit(tree)
  }
}
