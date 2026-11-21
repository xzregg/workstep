import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import type { Root } from 'hast'
import rehypeWebCitations from '../utils/rehypeWebCitations'

// This module belongs to the worker bundle, never the UI rendering path.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true })
export function parseMarkdownTree(content: string, incompleteCitation?: string): Root {
  const tree = processor.runSync(processor.parse(content)) as Root
  rehypeWebCitations(incompleteCitation)(tree)
  return tree
}
