import { memo, startTransition, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import type ReactMarkdown from 'react-markdown'
import type { UrlTransform } from 'react-markdown'
import { MarkdownParseQueue, type ParseResult } from '../markdown/MarkdownParseQueue'
import { renderMarkdownTree } from '../markdown/renderMarkdownTree'

const queue = new MarkdownParseQueue(() => new Worker(new URL('../markdown/markdown.worker.ts', import.meta.url), { type: 'module' }))

/** Heavy parsing cannot compete with input. Keep the last parsed prefix while
 * the worker coalesces new arrivals, then commit it at transition priority. */
function WorkerMarkdownBlock({ content, source = content, incompleteCitation, components, urlTransform, paused = false }: {
  content: string
  source?: string
  incompleteCitation?: string
  components: ComponentProps<typeof ReactMarkdown>['components']
  urlTransform: UrlTransform
  paused?: boolean
}) {
  const owner = useRef({})
  const latest = useRef(source)
  latest.current = source
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const pending = useRef<ParseResult | null>(null)
  const [result, setResult] = useState<ParseResult | null>(null)
  useEffect(() => {
    queue.submit(owner.current, content, incompleteCitation, next => {
      if (!latest.current.startsWith(next.source)) return
      if (pausedRef.current) { pending.current = next; return }
      startTransition(() => setResult(next))
    }, source)
  }, [content, source, incompleteCitation])
  useEffect(() => {
    if (!paused && pending.current) {
      const next = pending.current
      pending.current = null
      if (source.startsWith(next.source)) startTransition(() => setResult(next))
    }
  }, [paused, source])
  useEffect(() => {
    const key = owner.current
    return () => queue.cancel(key)
  }, [])
  // Long blocks commit native text in coalesced snapshots; do not create
  // thousands of per-leaf animation states while the UI is under load.
  const rendered = useMemo(() => result?.tree
    ? renderMarkdownTree(result.tree, components, urlTransform) : null,
  [result, components, urlTransform])
  // Worker failure never falls back to an expensive synchronous parse.
  if (!result || !source.startsWith(result.source) || !result.tree) {
    return <p className="markdown-worker-fallback">{content}</p>
  }
  return rendered
}
export default memo(WorkerMarkdownBlock)
