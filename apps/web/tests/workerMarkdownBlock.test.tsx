import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { defaultUrlTransform } from 'react-markdown'
import WorkerMarkdownBlock from '../src/components/WorkerMarkdownBlock'
import MarkdownContent from '../src/components/MarkdownContent'
import { I18nProvider } from '../src/i18n'
import { parseMarkdownTree } from '../src/markdown/parseMarkdownTree'

class FakeWorker {
  static instance: FakeWorker
  jobs: any[] = []
  onmessage: any
  onerror: any
  onmessageerror: any
  constructor() { FakeWorker.instance = this }
  postMessage(job: any) { this.jobs.push(job) }
  terminate() {}
  deliver() {
    const job = this.jobs.shift()
    this.onmessage({ data: { id: job.id, tree: parseMarkdownTree(job.content) } })
  }
}
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker })

test('worker results progress during streaming, preserve selection freeze and reject replaced content', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const components = {}
  const render = (content: string, paused = false) => act(async () => root.render(
    <WorkerMarkdownBlock content={content} paused={paused} components={components} urlTransform={defaultUrlTransform}/>
  ))
  try {
    await render('**第一版**')
    assert.ok(host.querySelector('strong') === null, 'parsing waits for worker')
    await render('**第一版**后续')
    await act(async () => FakeWorker.instance.deliver())
    assert.equal(host.querySelector('strong')?.textContent, '第一版', 'show progress even with a newer version waiting')
    await render('**第一版**后续', true)
    const before = host.innerHTML
    await act(async () => FakeWorker.instance.deliver())
    assert.equal(host.innerHTML, before, 'worker completion must not disturb a selection')
    await render('**第一版**后续')
    assert.equal(host.textContent, '第一版后续')
    await render('**旧任务**')
    await render('**新任务**')
    await act(async () => FakeWorker.instance.deliver())
    assert.ok(!host.textContent?.includes('旧任务'))
    await act(async () => FakeWorker.instance.deliver())
    assert.equal(host.querySelector('strong')?.textContent, '新任务')
  } finally { await act(async () => root.unmount()); host.remove() }
})


test('synthetic closing fences do not reject in-flight code-block progress', async () => {
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const components = {}
  const render = (source: string) => act(async () => root.render(
    <WorkerMarkdownBlock source={source} content={source + '\n~~~'} components={components} urlTransform={defaultUrlTransform}/>
  ))
  try {
    await render('~~~ts\nconst a')
    await render('~~~ts\nconst abc')
    await act(async () => FakeWorker.instance.deliver())
    assert.equal(host.querySelector('code')?.textContent, 'const a\n')
    await act(async () => FakeWorker.instance.deliver())
    assert.equal(host.querySelector('code')?.textContent, 'const abc\n')
  } finally { await act(async () => root.unmount()); host.remove() }
})


test('many short paragraphs in a long history message use one Worker parse', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const content = ('历史段落 **重点**，每段短但整篇很长。\n\n').repeat(120)
  try {
    await act(async () => root.render(<I18nProvider><MarkdownContent content={content}/></I18nProvider>))
    assert.equal(FakeWorker.instance.jobs.length, 1)
    assert.equal(FakeWorker.instance.jobs[0].content, content)
    assert.equal(host.querySelectorAll('strong').length, 0)
    await act(async () => FakeWorker.instance.deliver())
    assert.equal(host.querySelectorAll('strong').length, 120)
    assert.ok(host.querySelector('.markdown-worker-fallback') === null)
  } finally { await act(async () => root.unmount()); host.remove() }
})
