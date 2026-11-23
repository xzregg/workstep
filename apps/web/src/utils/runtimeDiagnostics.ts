export type RuntimeMark = 'chat-first-chunk' | 'chat-first-display' | 'chat-stream-commit' |
  'chat-history' | 'chat-react-render' | 'chat-follow' | 'markdown-queue' | 'markdown-parse'

interface CaptureStatus { recording: boolean; result: object | null }
interface Recorder {
  start(): boolean
  stop(): object | null
  snapshot(): CaptureStatus
  stamp(): number | undefined
  captureId(): number | undefined
  mark(type: RuntimeMark, at: number, duration?: number): void
}

export interface RuntimeLog { at: number; source: string; level: string; summary: string; detail?: string }
interface RuntimeViewAdapter {
  read(full: boolean): { available: boolean; environment: Record<string, string>; performance: CaptureStatus; logs?: RuntimeLog[] }
  start(): boolean
  stop(): void
  copy(text: string): Promise<void>
  save(text: string): Promise<boolean>
}

declare global {
  interface Window {
    workstepPerformance?: Recorder
    mountWorkstepDiagnostics?: (root: HTMLElement, adapter: RuntimeViewAdapter) => () => void
  }
}

const pending = new Map<string, number>()
const firstChunks = new Map<string, number>()
let activeRecording: number | undefined

function currentChatStamp() {
  const now = runtimeStamp()
  if (now === undefined) return
  const id = window.workstepPerformance?.captureId()
  if (activeRecording !== id) {
    activeRecording = id
    pending.clear()
    firstChunks.clear()
  }
  return now
}

export function runtimeStamp() {
  return typeof window === 'undefined' ? undefined : window.workstepPerformance?.stamp()
}

export function runtimeMark(type: RuntimeMark, start = runtimeStamp(), duration = 0) {
  if (start !== undefined) window.workstepPerformance?.mark(type, start, duration)
}

export function timeRuntimeMark(type: RuntimeMark, start: number | undefined) {
  const now = runtimeStamp()
  if (start !== undefined && now !== undefined) runtimeMark(type, start, now - start)
}

function retain(map: Map<string, number>, key: string, at: number) {
  map.set(key, at)
  if (map.size > 64) map.delete(map.keys().next().value!)
}

export function markChatSend(session: string) {
  const now = currentChatStamp()
  if (now !== undefined) retain(pending, session, now)
  return now
}

export function clearChatSend(session: string, at: number | undefined) {
  if (at !== undefined && pending.get(session) === at) pending.delete(session)
}

export function moveChatSend(previous: string, next: string, at: number | undefined) {
  if (at === undefined || pending.get(previous) !== at) return
  pending.delete(previous)
  retain(pending, next, at)
}

export function markChatChunk(session: string, message: string) {
  const now = currentChatStamp()
  if (now === undefined) return
  const send = pending.get(session)
  if (send !== undefined) {
    pending.delete(session)
    runtimeMark('chat-first-chunk', send, now - send)
  }
  if (!firstChunks.has(message)) {
    retain(firstChunks, message, now)
  }
}

export function markChatDisplay(message: string | undefined, rendered: () => boolean) {
  const now = currentChatStamp()
  const first = message ? firstChunks.get(message) : undefined
  if (now === undefined || first === undefined || first < 0) return true
  if (!rendered()) return false
  firstChunks.set(message!, -1)
  runtimeMark('chat-first-display', first, now - first)
  return true
}
