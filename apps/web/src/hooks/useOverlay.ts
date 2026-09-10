import { useEffect, useRef, type RefObject } from 'react'

type Entry = { id: string; close: () => void; element: HTMLElement; withHistory: boolean }
const stack: Entry[] = []
let nextId = 0
let skippingPop = 0
let baseOverflow = ''
const marker = '__workstepOverlay'

function onPop(event: PopStateEvent) {
  if (skippingPop) { skippingPop--; event.stopImmediatePropagation(); return }
  const arrivedMarker = event.state?.[marker]
  if (arrivedMarker && !stack.some(entry => entry.id === arrivedMarker)) {
    event.stopImmediatePropagation(); history.back(); return
  }
  const top = stack.at(-1)
  if (!top) {
    if (event.state?.[marker]) { event.stopImmediatePropagation(); history.back() }
    return
  }
  if (!top.withHistory) return
  // Restore the same URL while a dirty editor decides whether it may close.
  // Disposal consumes this entry after the user confirms.
  event.stopImmediatePropagation()
  history.pushState({ ...history.state, [marker]: top.id }, '')
  top.close()
}

/** Shared focus, scroll and Back behavior for drawers, sheets and full-screen editors. */
export function useOverlay(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>, withHistory = true) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const element = ref.current
    if (!open || !element) return
    const previous = document.activeElement as HTMLElement | null
    const entry: Entry = { id: `overlay-${++nextId}`, close: () => close.current(), element, withHistory }
    const focusable = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')]
      .filter(node => {
        if (node.closest('[hidden], [inert], [aria-hidden="true"]')) return false
        for (let current: HTMLElement | null = node; current; current = current.parentElement) {
          const style = window.getComputedStyle(current)
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (current === element) break
        }
        return true
      })
    if (!stack.length) baseOverflow = document.body.style.overflow
    stack.push(entry)
    let disposed = false
    if (withHistory) {
      window.addEventListener('popstate', onPop, true)
      queueMicrotask(() => {
        if (!disposed) history.pushState({ ...history.state, [marker]: entry.id }, '')
      })
    }
    document.body.style.overflow = 'hidden'
    ;(focusable()[0] || element).focus()
    const onKey = (event: KeyboardEvent) => {
      if (stack.at(-1) !== entry) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current() }
      if (event.key !== 'Tab') return
      const nodes = focusable()
      const index = nodes.indexOf(document.activeElement as HTMLElement)
      if (!nodes.length) { event.preventDefault(); element.focus(); return }
      if (event.shiftKey && index <= 0) { event.preventDefault(); nodes.at(-1)!.focus() }
      else if (!event.shiftKey && (index === nodes.length - 1 || index < 0)) { event.preventDefault(); nodes[0].focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      disposed = true
      document.removeEventListener('keydown', onKey, true)
      const index = stack.indexOf(entry)
      if (index !== -1) stack.splice(index, 1)
      if (withHistory) {
        if (history.state?.[marker] === entry.id) {
          skippingPop++
          history.back()
        }
        // Keep the capture listener installed until the disposal pop arrives.
      }
      document.body.style.overflow = stack.length ? 'hidden' : baseOverflow
      if (previous?.isConnected) previous.focus()
    }
  }, [open, ref, withHistory])
}
