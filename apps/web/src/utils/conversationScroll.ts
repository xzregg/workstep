/** Shared follow and scroll rules for task, assistant, and process conversations. */
export function isNearConversationBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 80,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

type TextSelection = Pick<Selection, 'anchorNode' | 'focusNode' | 'isCollapsed'>

/** 用户正在会话区选择文字时暂停自动跟随，避免新 token 把选区拖离视口。 */
export function hasActiveSelectionWithin(
  element: Element | null,
  selection: TextSelection | null | undefined,
): boolean {
  if (!element || !selection || selection.isCollapsed) return false
  const { anchorNode, focusNode } = selection
  return Boolean(
    (anchorNode && element.contains(anchorNode))
    || (focusNode && element.contains(focusNode)),
  )
}

/**
 * 区分 scroll 事件是「用户手动滚动」还是「内容高度变化引发的浏览器自动钳制」。
 *
 * 对话内容整体变矮时（如思考块结束后自动折叠、过程追踪收起），浏览器会把
 * scrollTop 自动钳制到新的底部并触发 scroll 事件。只看 scrollTop 减小会把这次
 * 钳制误判为“用户向上滚动”，从而错误关闭跟随（钉底）。
 *
 * 判定：scrollTop 减小 + 同一事件里 scrollHeight 也减小 + 钳制后恰好落在底部，
 * 视为自动钳制（保留原跟随状态，不取消跟随）；
 * scrollTop 减小但高度未减小则是用户手动上滚（应取消跟随）。
 * 用户滚轮/键盘上滚在 capture 步骤已先行取消跟随，因此不会在此被保留。
 */
export function isAutoShrinkClamp({
  scrollTop,
  prevScrollTop,
  scrollHeight,
  prevScrollHeight,
  clientHeight,
}: {
  scrollTop: number
  prevScrollTop: number
  scrollHeight: number
  prevScrollHeight: number
  clientHeight: number
}): boolean {
  if (!(scrollTop < prevScrollTop)) return false
  if (!(scrollHeight < prevScrollHeight)) return false
  return scrollHeight - scrollTop - clientHeight <= 1
}

type ConversationNavigationIntent =
  | { type: 'wheel'; deltaY: number }
  | { type: 'key'; key: string }

/** 在浏览器真正更新 scrollTop 前识别“查看较早消息”的用户意图。 */
export function shouldPauseConversationFollow(
  intent: ConversationNavigationIntent,
): boolean {
  if (intent.type === 'wheel') return intent.deltaY < 0
  return intent.key === 'ArrowUp' || intent.key === 'PageUp' || intent.key === 'Home'
}


/** 把对话容器钉到底部所需的 scrollTop（不低于 0）。 */
export function conversationBottomScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight)
}

/**
 * 观察消息内容包裹层的高度变化。
 *
 * overflow 容器的 border-box 高度是固定的（填满父级），ResizeObserver 观察
 * 容器本身不会因 scrollHeight 变化触发；必须观察其内容包裹层（高度 = 内容高度）。
 * 消息数据 effect 只覆盖消息新增/内容变化，而展开、折叠思考块（ProcessTrace 的
 * `<details>`）、过程追踪等纯 UI 状态变化不会改变消息数据却会改变内容高度，
 * 这类变化由本 helper 捕获，让调用方在跟随中重新钉底。
 *
 * 内容高度变化超过 1px 时回调一次；返回取消观察的 cleanup。
 */
export function observeContentResize({
  containerRef,
  contentRef,
  onResize,
}: {
  containerRef: { current: HTMLElement | null }
  contentRef: { current: HTMLElement | null }
  onResize: (info: { height: number; prevHeight: number }) => void
}): () => void {
  const container = containerRef.current
  const content = contentRef.current
  if (!container || !content || typeof ResizeObserver === 'undefined') {
    return () => { /* 无法观察时不挂监听 */ }
  }
  let prevHeight = container.scrollHeight
  const observer = new ResizeObserver(() => {
    const height = container.scrollHeight
    if (Math.abs(height - prevHeight) < 1) return
    const previous = prevHeight
    prevHeight = height
    onResize({ height, prevHeight: previous })
  })
  observer.observe(content)
  return () => observer.disconnect()
}
