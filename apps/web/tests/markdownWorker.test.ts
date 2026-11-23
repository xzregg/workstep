import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseMarkdownTree } from '../src/markdown/parseMarkdownTree'
import { renderMarkdownTree } from '../src/markdown/renderMarkdownTree'
import { MarkdownParseQueue } from '../src/markdown/MarkdownParseQueue'

for (const content of [
  '# 标题\n\n- 第一项\n  - 嵌套\n\n- **第二项**\n\n> 引用',
  '| 表格 | 值 |\n|---|---|\n| a | `b` |\n\n```ts\nconst a = 1\n```',
  '[引用][a]\n\n[a]: https://example.com\n\n~~删除~~\n\n- [x] 完成',
  '<script>alert(1)</script>\n\n[危险](javascript:alert%281%29) ![x](javascript:x)',
]) test('worker tree keeps Markdown semantics and URL safety: '+content.slice(0,12), () => {
  assert.equal(renderToStaticMarkup(renderMarkdownTree(parseMarkdownTree(content), {})),
    renderToStaticMarkup(createElement(ReactMarkdown, {remarkPlugins:[remarkGfm]}, content)))
})

test('queue coalesces pending revisions, delivers progress, isolates owners and cancels unmounted jobs', () => {
  const sent: any[] = [], results: string[] = []
  const worker = { postMessage: (job: any) => sent.push(job), terminate() {}, onmessage: null as any, onerror: null as any, onmessageerror: null as any }
  const queue = new MarkdownParseQueue(() => worker)
  const a = {}, b = {}
  const receive = (result: any) => results.push(result.content)
  queue.submit(a, 'first', undefined, receive)
  queue.submit(a, 'second', undefined, receive)
  queue.submit(a, 'latest', undefined, receive)
  queue.submit(b, 'other', undefined, receive)
  assert.equal(sent.length, 1)
  worker.onmessage({data:{id:sent[0].id,tree:{type:'root',children:[]}}})
  assert.deepEqual(results,['first'], 'continuous input must not starve visible progress')
  assert.equal(sent[1].content,'latest')
  queue.cancel(b)
  worker.onmessage({data:{id:sent[1].id,tree:{type:'root',children:[]}}})
  assert.deepEqual(results,['first','latest'])
  assert.equal(sent.length,2)
  queue.dispose()
})

test('worker failure reports a plain-text fallback without invoking a synchronous parser', () => {
  const worker = { postMessage() {}, terminate() {}, onmessage:null as any, onerror:null as any, onmessageerror:null as any }
  const queue = new MarkdownParseQueue(() => worker)
  let result: unknown = 'pending'
  queue.submit({}, 'text', undefined, value => { result = value.tree })
  worker.onerror()
  assert.equal(result,null)
  queue.dispose()
})

test('runtime diagnostics record waiting and Worker execution separately', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let now = 10
  const marks: unknown[][] = []
  const sent: Array<{ id: number; measure?: boolean }> = []
  const worker = {
    postMessage: (job: { id: number; measure?: boolean }) => sent.push(job),
    terminate() {}, onmessage: null as any, onerror: null, onmessageerror: null,
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { workstepPerformance: {
    stamp: () => now, mark: (...values: unknown[]) => marks.push(values),
  } } })
  const queue = new MarkdownParseQueue(() => worker)
  try {
    queue.submit({}, 'first', undefined, () => {})
    now = 20
    queue.submit({}, 'second', undefined, () => {})
    now = 40
    worker.onmessage({ data: { id: sent[0].id, parseMs: 9 } })
    now = 60
    worker.onmessage({ data: { id: sent[1].id, parseMs: 12 } })
    assert.deepEqual(sent.map(job => job.measure), [true, true])
    assert.deepEqual(marks, [
      ['markdown-queue', 10, 0], ['markdown-parse', 10, 9],
      ['markdown-queue', 20, 20], ['markdown-parse', 40, 12],
    ])
  } finally {
    queue.dispose()
    if (prior) Object.defineProperty(globalThis, 'window', prior)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
