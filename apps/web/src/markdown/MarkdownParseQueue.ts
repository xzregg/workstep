import { runtimeMark, runtimeStamp, timeRuntimeMark } from '../utils/runtimeDiagnostics'
import type { Root } from 'hast'
export interface ParseResult { content: string; source: string; tree: Root | null }
interface Request { id: number; content: string; incompleteCitation?: string; measure?: boolean }
interface Reply { id: number; tree?: Root; parseMs?: number }
interface ParserWorker {
  postMessage: (request: Request) => void
  terminate: () => void
  onmessage: ((event: MessageEvent<Reply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
}
type Job = Request & { queuedAt?: number; sentAt?: number; source: string; owner: object; receive: (result: ParseResult) => void }

/** One active parse globally and only the latest waiting revision per owner. */
export class MarkdownParseQueue {
  private worker?: ParserWorker
  private waiting = new Map<object, Job>()
  private listeners = new Map<object, Job['receive']>()
  private active?: Job
  private sequence = 0
  private failed = false
  private timeout?: ReturnType<typeof setTimeout>
  private createWorker: () => ParserWorker
  constructor(createWorker: () => ParserWorker) { this.createWorker = createWorker }
  submit(owner: object, content: string, incompleteCitation: string | undefined, receive: Job['receive'], source = content) {
    if (this.failed) { receive({ content, source, tree: null }); return }
    this.listeners.set(owner, receive)
    this.waiting.set(owner, { owner, content, source, incompleteCitation, receive, queuedAt: runtimeStamp(), id: ++this.sequence })
    this.pump()
  }
  cancel(owner: object) { this.waiting.delete(owner); this.listeners.delete(owner) }
  private fail = () => {
    this.failed = true
    const jobs = new Map(this.waiting)
    if (this.active && !jobs.has(this.active.owner)) jobs.set(this.active.owner, this.active)
    for (const job of jobs.values()) this.listeners.get(job.owner)?.({ content: job.content, source: job.source, tree: null })
    this.dispose()
  }
  private pump() {
    if (this.active || !this.waiting.size) return
    try {
      if (!this.worker) {
        this.worker = this.createWorker()
        this.worker.onerror = this.fail
        this.worker.onmessageerror = this.fail
        this.worker.onmessage = ({ data }) => {
          const job = this.active
          if (!job || data.id !== job.id) return
          if (job.sentAt !== undefined && data.parseMs !== undefined) runtimeMark('markdown-parse', job.sentAt, data.parseMs)
          clearTimeout(this.timeout)
          this.active = undefined
          // Deliver intermediate progress even when a newer prefix is queued.
          // The subscriber rejects replacements from another content generation.
          this.listeners.get(job.owner)?.({ content: job.content, source: job.source, tree: data.tree ?? null })
          if (!this.waiting.has(job.owner)) this.listeners.delete(job.owner)
          this.pump()
        }
      }
      const job = this.waiting.values().next().value!
      this.waiting.delete(job.owner)
      this.active = job
      job.sentAt = runtimeStamp()
      timeRuntimeMark('markdown-queue', job.queuedAt)
      this.timeout = setTimeout(this.fail, 15000)
      this.worker.postMessage({ id: job.id, content: job.content, incompleteCitation: job.incompleteCitation, ...(job.sentAt === undefined ? {} : { measure: true }) })
    } catch { this.fail() }
  }
  dispose() {
    clearTimeout(this.timeout)
    this.worker?.terminate()
    this.worker = undefined
    this.active = undefined
    this.waiting.clear()
    this.listeners.clear()
  }
}
