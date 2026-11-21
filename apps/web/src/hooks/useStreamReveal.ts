import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useActiveSkin } from '../skins/runtime'
import type { SkinEffects } from '../skins/contract'

function subscribeReducedMotion(listener: () => void) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 两次揭示帧之间的最小间隔。
 *
 * Markdown只在已揭示前缀改变时解析，90ms间隔限制全文重解析频率。
 * 字符由叶节点按绘制帧追加，不把Markdown解析提高到绘制帧率。
 */
export const MIN_REVEAL_FRAME_MS = 90

/**
 * 常规吐字速度（字符/秒）。正文与思考块共用同一个 hook，节奏完全一致：
 * token 平稳到达时按这个速度逐帧浮现。
 */
export const REVEAL_CHARS_PER_SECOND = 90
const MAX_SMOOTH_STEP_CHARS = 32
const LIVE_CATCH_UP_DURATION_MS = 900
const SMOOTH_BACKLOG_LIMIT = 2048

/**
 * 超大积压的追平预算（毫秒）。普通实时回复每次最多推进32字，
 * 超过2048字的批量恢复才允许更大的步长，避免长时间追字。
 */
export const MAX_REVEAL_DURATION_MS = 450

/** 常规节奏下每帧推进的字符数。 */
export const REVEAL_STEP_CHARS = Math.max(
  1,
  Math.round((REVEAL_CHARS_PER_SECOND * MIN_REVEAL_FRAME_MS) / 1000),
)

/** 上限时长内可用的帧数；积压量按它摊平，得到动态步长。 */
export const MAX_CATCH_UP_FRAMES = Math.max(
  1,
  Math.ceil(MAX_REVEAL_DURATION_MS / MIN_REVEAL_FRAME_MS),
)

/** Keep ordinary output slow, accelerate live backlogs in bounded slices,
 * and drain promptly once the engine has finished. */
export function revealStepFor(
  remaining: number,
  currentStep: number = REVEAL_STEP_CHARS,
  options: SkinEffects = {},
  streaming = true,
  arrivalCharsPerSecond?: number,
): number {
  const base = Math.max(1, Math.round(((options.charsPerSecond ?? REVEAL_CHARS_PER_SECOND) * MIN_REVEAL_FRAME_MS) / 1000))
  const frames = Math.max(1, Math.ceil((options.maxDurationMs ?? MAX_REVEAL_DURATION_MS) / MIN_REVEAL_FRAME_MS))
  if (remaining <= 0) return base
  const step = Math.max(
    currentStep,
    base,
    Math.ceil(remaining / frames),
  )
  if (streaming && remaining <= SMOOTH_BACKLOG_LIMIT && currentStep <= MAX_SMOOTH_STEP_CHARS && base <= MAX_SMOOTH_STEP_CHARS) {
    const liveFrames = Math.ceil(Math.max(LIVE_CATCH_UP_DURATION_MS, options.maxDurationMs ?? 0) / MIN_REVEAL_FRAME_MS)
    // Leave a small cushion when transport is slower than the preferred reading
    // rate. Recompute live speed instead of ratcheting until the queue is empty.
    const deliveryStep = arrivalCharsPerSecond == null ? base
      : Math.max(1, Math.round(arrivalCharsPerSecond * 0.85 * MIN_REVEAL_FRAME_MS / 1000))
    return Math.min(MAX_SMOOTH_STEP_CHARS, Math.max(arrivalCharsPerSecond == null ? currentStep : 0, Math.min(base, deliveryStep), Math.ceil(remaining / liveFrames)))
  }
  return step
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Advance to a complete grapheme boundary, including emoji and combining marks. */
function revealBoundary(text: string, start: number, step: number): number {
  if (start + step >= text.length) return text.length
  for (const part of segmenter.segment(text.slice(start))) {
    const end = start + part.index + part.segment.length
    if (end >= start + step) return end
  }
  return text.length
}

/**
 * 流式文本揭示层：输入父级最新 content，输出"当前应渲染的前缀"。
 *
 * 不变量（只加视觉节奏，不改语义）：
 * - enabled=false：恒等直通，零开销
 * - 首次挂载时已有正文（包括仍标记 running 的恢复消息）：恒等直通，不复现动画
 * - frozen（选区冻结）结束：立即全量直通
 * - content 不是已揭示前缀的延伸（内容被替换而非追加）：重置并全额直通
 * - 实时积压自适应加速；引擎结束后在追平预算内收尾，不瞬间跳满；
 *   揭示只前进不回放，收敛后停表
 */
export default function useStreamReveal(
  content: string,
  streaming: boolean,
  frozen: boolean,
  enabled: boolean,
  revealInitial = false,
): string {
  const effects = useActiveSkin().effects
  const reduce = useSyncExternalStore(subscribeReducedMotion, reducedMotion, () => false)
  enabled = enabled && effects?.reveal !== false && !reduce
  const settings = useRef(effects); settings.current = effects
  const baseStep = revealStepFor(0, 0, effects)
  // 空气泡后到达的正文，以及时间线明确标记的新实时块均逐步展开。
  // 其余首屏已有正文直接显示，包括仍标记 running 的恢复历史。
  const [shown, setShown] = useState(() => (
    enabled && streaming && (content.length === 0 || revealInitial) ? '' : content
  ))
  const shownRef = useRef(shown)
  // tick 在 setTimeout 里异步执行，闭包里的 content 是"排程那一刻"的快照。
  // 流式期间新内容不断追加，必须读最新值，否则揭示会停在旧长度上不再前进。
  const contentRef = useRef(content)
  contentRef.current = content
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  const prevFrozenRef = useRef(frozen)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRevealAt = useRef<number | null>(null)
  const arrival = useRef<{ text: string; at: number; rate?: number }>({ text: content, at: performance.now() })
  // Live speed may fall as the buffer shrinks; bulk/completed drains retain
  // their peak step so their catch-up budget does not acquire a long tail.
  const stepRef = useRef(baseStep)
  useEffect(() => { stepRef.current = baseStep }, [baseStep, effects?.maxDurationMs])

  useEffect(() => {
    const now = performance.now()
    const previous = arrival.current
    if (!enabled || frozen || !content.startsWith(previous.text)) {
      arrival.current = { text: content, at: now }
    } else if (content !== previous.text) {
      const elapsed = now - previous.at
      // Coalesce tiny transport deltas into meaningful samples. Do not include
      // time spent waiting for the engine's first token in its delivery rate.
      if (!previous.text || elapsed > 2000) arrival.current = { text: content, at: now }
      else if (elapsed >= MIN_REVEAL_FRAME_MS) {
        const sample = (content.length - previous.text.length) * 1000 / elapsed
        arrival.current = { text: content, at: now, rate: previous.rate == null ? sample : previous.rate * 0.65 + sample * 0.35 }
      }
    }
    const stopTimer = () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    const resetTo = (next: string) => {
      stopTimer()
      if (shownRef.current !== next) {
        shownRef.current = next
        setShown(next)
      }
    }

    // 冻结结束（选区释放）：立即追平
    if (!frozen && prevFrozenRef.current) {
      prevFrozenRef.current = frozen
      resetTo(content)
      return
    }
    prevFrozenRef.current = frozen

    // 动画关闭：直通全量
    if (!enabled) {
      resetTo(content)
      return
    }

    // 选区冻结：按住当前进度，并停掉正在跑的定时器
    if (frozen) {
      stopTimer()
      return
    }

    // 内容被替换（选区快照切换 / 父级重建）：重置并直通
    if (!content.startsWith(shownRef.current)) {
      resetTo(content)
      return
    }

    // 还有未揭示内容：按动态速度推进（常规节奏，积压时自动提速）。
    // 结束后仍平滑排空，但使用快速收尾预算，避免引擎完成后长时间追字。
    if (shownRef.current.length < content.length && timerRef.current == null) {
      const tick = () => {
        timerRef.current = null
        const target = contentRef.current
        const remaining = target.length - shownRef.current.length
        if (remaining <= 0) {
          stepRef.current = revealStepFor(0, 0, settings.current)
          return
        }
        // 普通实时积压按小步推进，超大批量恢复才使用快速追平。
        stepRef.current = revealStepFor(remaining, stepRef.current, settings.current, streamingRef.current, arrival.current.rate)
        lastRevealAt.current = performance.now()
        const step = Math.min(remaining, stepRef.current)
        resetTo(target.slice(0, revealBoundary(target, shownRef.current.length, step)))
        if (contentRef.current.length - shownRef.current.length > 0) {
          timerRef.current = setTimeout(tick, MIN_REVEAL_FRAME_MS)
        } else {
          stepRef.current = revealStepFor(0, 0, settings.current)
        }
      }
      // Give a tiny opening at most two parse intervals to collect its next
      // packet. Later arrivals reuse the cadence instead of adding a fresh 90ms
      // wait every time the buffer happened to run dry.
      const delay = lastRevealAt.current == null
        ? (streaming && content.length < baseStep ? MIN_REVEAL_FRAME_MS * 2 : 0)
        : Math.max(0, MIN_REVEAL_FRAME_MS - (performance.now() - lastRevealAt.current))
      if (delay === 0) tick()
      else timerRef.current = setTimeout(tick, delay)
    }
  }, [content, streaming, frozen, enabled])

  // 卸载清理
  useEffect(() => {
    return () => {
      // 必须同时置空引用：StrictMode 会在开发环境执行"挂载→清理→再挂载"，
      // 若清理只 clearTimeout 而保留旧句柄，重挂载后的
      // `timerRef.current == null` 守卫会永远为假，揭示定时器再也排不上队，
      // 正文只能等到 streaming 结束才一次性显示。
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  return shown
}
