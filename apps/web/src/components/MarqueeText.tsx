import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react'

interface MarqueeTextProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** 完整标题文本（始终存在于 DOM，仅视觉裁剪，可被屏幕阅读器读取） */
  text: string
  /** 走马灯滚动速度（像素/秒），默认 60 */
  speed?: number
}

/**
 * 截断标题的走马灯（Codex 风格）。
 *
 * - 文本未溢出：正常显示（未截断时无省略号）。
 * - 文本被截断：默认显示省略号；鼠标悬停时完整标题在可视区域内来回滚动，
 *   直到能读到被裁掉的部分，移出后回到省略号。
 * - 遵循系统「减少动态效果」偏好：此时不滚动，保持省略号。
 *
 * 除 `text`/`speed` 外，其余 span 属性（如 onDoubleClick、style 中的字重/删除线、
 * title 等）都会透传到外层裁剪容器，便于在不同列表里复用。
 */
export default function MarqueeText({
  text,
  className = '',
  style,
  speed = 60,
  onMouseEnter,
  onMouseLeave,
  ...rest
}: MarqueeTextProps) {
  const outerRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)
  const [hover, setHover] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)

  // 系统「减少动态效果」偏好（含设置变化时实时更新）
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    setReducedMotion(mq.matches)
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [])

  const measure = () => {
    const outer = outerRef.current
    const content = contentRef.current
    if (!outer || !content) return
    const dist = content.scrollWidth - outer.clientWidth
    setOverflow(Math.max(0, dist))
  }

  const active = hover && overflow > 0 && !reducedMotion

  useEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const targets = [outerRef.current, contentRef.current].filter(Boolean) as Element[]
    const ro = new ResizeObserver(measure)
    targets.forEach((el) => ro.observe(el))
    return () => ro.disconnect()
    // measure 每次渲染重建，但仅依赖 DOM 实测值，无需列入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, active])

  // 时长按溢出距离与速度换算（keyframes 含两端停顿），夹在 2.4s~12s 之间
  const duration = overflow > 0 ? Math.min(12, Math.max(2.4, (overflow / speed) * 2.4)) : 0
  const custom: CSSProperties = overflow > 0
    ? { '--ws-marquee-duration': `${duration}s`, '--ws-marquee-shift': `${-overflow}px` } as CSSProperties
    : {}

  return (
    <span
      {...rest}
      ref={outerRef}
      className={`ws-marquee${active ? ' is-marquee' : ''}${className ? ` ${className}` : ''}`}
      style={{ flex: 1, minWidth: 0, ...custom, ...style } as CSSProperties}
      onMouseEnter={(e) => { onMouseEnter?.(e); setHover(true) }}
      onMouseLeave={(e) => { onMouseLeave?.(e); setHover(false) }}
    >
      {active ? (
        <span className="ws-marquee__track">
          <span ref={contentRef} className="ws-marquee__inner">{text}</span>
        </span>
      ) : (
        <span ref={contentRef} className="ws-marquee__ellipsis">{text}</span>
      )}
    </span>
  )
}