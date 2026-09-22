import {
  createContext,
  useCallback,
  useEffect,
  useState,
  type RefObject,
} from 'react'
import { conversationBottomScrollTop } from '../pages/taskDetailChat'

/** 悬浮面板与会话内容之间额外保留的间隙（px）。 */
const OVERLAY_GAP = 2

/**
 * 会话区底部悬浮面板（如「待插入消息」）的宿主通道。
 *
 * 面板把自己的根节点注册进来，由宿主负责测量高度并给会话区留出底部空间。
 * 这样面板经 `composerOverlay` 之类的插槽透传时，中间层不必再手工传 ref，
 * 新增一个会话界面也不会漏掉这段留白逻辑。
 */
export const ComposerOverlayHostContext = createContext<
  ((node: HTMLDivElement | null) => void) | null
>(null)

interface UseComposerOverlayClearanceOptions {
  /** 会话滚动容器（`.chat-history-scroll`）。 */
  scrollRef: RefObject<HTMLElement | null>
  /** 会话是否正在跟随底部。 */
  followRef: RefObject<boolean>
  /** 程序钉底写入的 scrollTop，用于识别滚动回显。 */
  programmaticRef: RefObject<number>
  /** 最近一次 scrollHeight 基准；钉底时同步，避免内容变高被误判为用户上滚。 */
  scrollHeightRef?: RefObject<number>
}

/**
 * 会话区底部悬浮面板的留白逻辑，所有会话界面共用：
 *
 * 1. 用 ResizeObserver 持续测量面板高度（含面板自身 marginBottom）——面板
 *    挂载/卸载、条目增删、进入编辑撑高都会自动重算，调用方无需跟踪面板数据；
 * 2. 包裹会话滚动容器的外层 div 留出「面板高度 + 2px」的底部内边距，
 *    滚动容器（height: 100%）随之整体变矮，避免面板遮住最后一条消息；
 * 3. 留白变化会改变容器高度/滚动位置，跟随中时重新钉底，避免底部露出空白。
 */
export function useComposerOverlayClearance({
  scrollRef,
  followRef,
  programmaticRef,
  scrollHeightRef,
}: UseComposerOverlayClearanceOptions) {
  const [overlayNode, setOverlayNode] = useState<HTMLDivElement | null>(null)
  const [overlayHeight, setOverlayHeight] = useState(0)

  useEffect(() => {
    if (!overlayNode) {
      setOverlayHeight(0)
      return
    }
    const node = overlayNode
    const measure = () => {
      // 无布局的环境（如最小 DOM stub 的测试）测不出高度，保持原值即可。
      if (typeof node.getBoundingClientRect !== 'function') return
      const margin = typeof getComputedStyle === 'function'
        ? getComputedStyle(node).marginBottom
        : node.style?.marginBottom
      const marginBottom = parseFloat(margin as string) || 0
      setOverlayHeight(Math.ceil(node.getBoundingClientRect().height + marginBottom))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [overlayNode])

  useEffect(() => {
    const container = scrollRef.current
    if (!container || !followRef.current) return
    const target = conversationBottomScrollTop(
      container.scrollHeight,
      container.clientHeight,
    )
    programmaticRef.current = target
    if (scrollHeightRef) scrollHeightRef.current = container.scrollHeight
    container.scrollTop = target
  }, [overlayHeight, scrollRef, followRef, programmaticRef, scrollHeightRef])

  const registerOverlay = useCallback((node: HTMLDivElement | null) => {
    setOverlayNode(node)
  }, [])

  /** 包裹层 padding-bottom：有悬浮面板时为「面板高度 + 2px」，否则为常规内边距。 */
  const overlayPaddingBottom = (basePaddingBottom: number) => (
    overlayHeight > 0 ? overlayHeight + OVERLAY_GAP : basePaddingBottom
  )

  return { registerOverlay, overlayHeight, overlayPaddingBottom }
}
