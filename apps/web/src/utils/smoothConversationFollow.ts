import { conversationBottomScrollTop, hasActiveSelectionWithin } from './conversationScroll'

type Ref<T> = { current: T }
type Motion = { frame: number; lastTime: number; initialized: boolean; cleanup?: () => void }
const motions = new WeakMap<HTMLElement, Motion>()

/** A single continuous trajectory per transcript, shared by token and resize events. */
export function followConversationBottom(container: HTMLElement, programmatic: Ref<number>, following: Ref<boolean>, immediate = false) {
  let motion = motions.get(container)
  if (!motion) {
    motion = { frame: 0, lastTime: 0, initialized: false }; motions.set(container, motion)
    if (typeof container.addEventListener === 'function') {
      let startY = 0
      const start = (event: TouchEvent) => { startY = event.touches[0]?.clientY ?? 0 }
      const move = (event: TouchEvent) => {
        if ((event.touches[0]?.clientY ?? startY) > startY + 3) following.current = false
      }
      container.addEventListener('touchstart', start, { passive: true })
      container.addEventListener('touchmove', move, { passive: true })
      motion.cleanup = () => { container.removeEventListener('touchstart', start); container.removeEventListener('touchmove', move) }
    }
  }
  const state = motion
  const reduced = container.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches
  const write = (top: number) => { programmatic.current = top; container.scrollTop = top }
  if (!following.current) return
  if (immediate || !state.initialized || reduced || typeof requestAnimationFrame === 'undefined') {
    stopConversationFollow(container)
    state.initialized = true
    write(conversationBottomScrollTop(container.scrollHeight, container.clientHeight))
    return
  }
  if (state.frame) return
  state.lastTime = 0
  const tick = (time: number) => {
    state.frame = 0
    if (!following.current || container.ownerDocument.hidden || hasActiveSelectionWithin(container, container.ownerDocument.getSelection())) return
    const target = conversationBottomScrollTop(container.scrollHeight, container.clientHeight)
    const dt = state.lastTime ? Math.min(40, time - state.lastTime) : 16
    state.lastTime = time
    const next = container.scrollTop + (target - container.scrollTop) * (1 - Math.exp(-dt / 65))
    if (Math.abs(target - next) < 0.5) { write(target); return }
    write(next)
    state.frame = requestAnimationFrame(tick)
  }
  state.frame = requestAnimationFrame(tick)
}

export function disposeConversationFollow(container: HTMLElement | null) {
  if (!container) return
  stopConversationFollow(container)
  motions.get(container)?.cleanup?.()
  motions.delete(container)
}

export function stopConversationFollow(container: HTMLElement | null) {
  if (!container) return
  const state = motions.get(container)
  if (state?.frame) { cancelAnimationFrame(state.frame); state.frame = 0 }
}
