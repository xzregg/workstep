import { useEffect, useRef, useState } from 'react'

/**
 * 两次揭示帧之间的最小间隔。
 *
 * 性能红线：流式期间 MarkdownContent 本来就会"每个 token 到达"重解析一次
 * markdown（频率 5–15fps，取决于 token 间隔）。揭示层的帧率绝不能超过它，
 * 否则会制造出原本不存在的重渲染，拖慢消息组件。90ms ≈ 11fps，
 * 低于 token 到达的实际频率上限。
 */
export const MIN_REVEAL_FRAME_MS = 90

/**
 * 常规吐字速度（字符/秒）。正文与思考块共用同一个 hook，节奏完全一致：
 * token 平稳到达时按这个速度逐帧浮现。
 */
export const REVEAL_CHARS_PER_SECOND = 120

/**
 * 积压排空上限（毫秒）。队列里剩得再多，也会动态提速，
 * 保证在这么久内全部吐完——否则 5000 字按常规速度要四十多秒，尾巴太长。
 */
export const MAX_REVEAL_DURATION_MS = 10_000

/** 常规节奏下每帧推进的字符数。 */
export const REVEAL_STEP_CHARS = Math.max(
  1,
  Math.ceil((REVEAL_CHARS_PER_SECOND * MIN_REVEAL_FRAME_MS) / 1000),
)

/** 上限时长内可用的帧数；积压量按它摊平，得到动态步长。 */
export const MAX_CATCH_UP_FRAMES = Math.max(
  1,
  Math.ceil(MAX_REVEAL_DURATION_MS / MIN_REVEAL_FRAME_MS),
)

/**
 * 计算本帧应推进的字符数。
 *
 * - 积压少：维持常规节奏（REVEAL_STEP_CHARS），保持平稳吐字观感
 * - 积压多：按 ceil(remaining / MAX_CATCH_UP_FRAMES) 提速
 * - 只增不减：调用方把结果存回 currentStep，使一批积压在排空前保持速度，
 *   否则步长会随 remaining 缩小而变小，尾巴被无限拉长
 *
 * 由于步长单调不减，剩余 R 个字符至多 ceil(R / step) ≤ MAX_CATCH_UP_FRAMES
 * 帧吐完，即不超过 MAX_REVEAL_DURATION_MS。
 */
export function revealStepFor(
  remaining: number,
  currentStep: number = REVEAL_STEP_CHARS,
): number {
  if (remaining <= 0) return REVEAL_STEP_CHARS
  return Math.max(
    currentStep,
    REVEAL_STEP_CHARS,
    Math.ceil(remaining / MAX_CATCH_UP_FRAMES),
  )
}

/**
 * 流式文本揭示层：输入父级最新 content，输出"当前应渲染的前缀"。
 *
 * 不变量（只加视觉节奏，不改语义）：
 * - enabled=false：恒等直通，零开销
 * - 首次挂载时不在流式中（历史消息）：恒等直通，不复现动画
 * - frozen（选区冻结）结束：立即全量直通
 * - content 不是已揭示前缀的延伸（内容被替换而非追加）：重置并全额直通
 * - 一旦开始揭示就按固定速度排空，streaming 结束也不跳满；
 *   揭示只前进不回放，收敛后停表
 */
export default function useStreamReveal(
  content: string,
  streaming: boolean,
  frozen: boolean,
  enabled: boolean,
): string {
  // 首次挂载就在流式中：从空开始揭示（新消息"浮现"）；否则直通。
  // 历史消息因此在挂载瞬间就是完整的，不会被重新"打一遍字"。
  const [shown, setShown] = useState(() => (enabled && streaming ? '' : content))
  const shownRef = useRef(shown)
  // tick 在 setTimeout 里异步执行，闭包里的 content 是"排程那一刻"的快照。
  // 流式期间新内容不断追加，必须读最新值，否则揭示会停在旧长度上不再前进。
  const contentRef = useRef(content)
  contentRef.current = content
  const prevFrozenRef = useRef(frozen)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 当前每帧步长。常规时等于 REVEAL_STEP_CHARS；积压过多时动态升速，
  // 并保持到这批积压排空，避免"指数逼近"永远追不上 10 秒上限。
  const stepRef = useRef(REVEAL_STEP_CHARS)

  useEffect(() => {
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

    // 还有未揭示内容：按动态速度推进（常规节奏，积压过多时自动提速）。
    // 这里刻意不看 streaming —— 消息结束后仍把剩余内容排空，
    // 否则一次性到达的长正文会"瞬间铺满"，失去吐字感。
    if (shownRef.current.length < content.length && timerRef.current == null) {
      const tick = () => {
        timerRef.current = null
        const target = contentRef.current
        const remaining = target.length - shownRef.current.length
        if (remaining <= 0) {
          stepRef.current = REVEAL_STEP_CHARS
          return
        }
        // 动态调速：积压多 → 升速，保证最多 10 秒排空；积压少 → 常规节奏。
        stepRef.current = revealStepFor(remaining, stepRef.current)
        const step = Math.min(remaining, stepRef.current)
        resetTo(target.slice(0, shownRef.current.length + step))
        if (contentRef.current.length - shownRef.current.length > 0) {
          timerRef.current = setTimeout(tick, MIN_REVEAL_FRAME_MS)
        } else {
          stepRef.current = REVEAL_STEP_CHARS
        }
      }
      timerRef.current = setTimeout(tick, MIN_REVEAL_FRAME_MS)
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
