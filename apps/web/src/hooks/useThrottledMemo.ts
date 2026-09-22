import { useEffect, useRef, useState } from 'react'

/**
 * 节流派生值：依赖高频变化（如流式输出时每个 token 都会重建 messages）而
 * 计算又昂贵（如扫描全部事件估算上下文占用）时，限制实际计算频率。
 *
 * - 距上次计算超过 intervalMs：在 effect 中立即重算（leading）；
 * - 否则安排一次尾部计算（trailing），保证流结束后最终值准确；
 * - 首帧同步计算一次，避免界面从空值闪变。
 */
export function useThrottledMemo<T>(
  compute: () => T,
  deps: unknown[],
  intervalMs: number,
): T {
  const computeRef = useRef(compute)
  computeRef.current = compute
  const [value, setValue] = useState<T>(() => compute())
  const lastRunRef = useRef<number>(Date.now())

  // deps 由调用方透传，无法静态展开；setValue 只在节流窗口触发，不会形成更新链。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const now = Date.now()
    const elapsed = now - lastRunRef.current
    if (elapsed >= intervalMs) {
      lastRunRef.current = now
      setValue(computeRef.current())
      return
    }
    const timer = window.setTimeout(() => {
      lastRunRef.current = Date.now()
      setValue(computeRef.current())
    }, intervalMs - elapsed)
    return () => window.clearTimeout(timer)
  }, deps)

  return value
}
