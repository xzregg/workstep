import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'
import Button from './Button'
import './QuickPromptOverflow.css'

/** One compact row; extra shortcuts live in an anchored card outside clipping containers. */
export default function QuickPromptOverflow({ items, prefix, label }: {
  items: ReactNode[]; prefix?: ReactNode; label?: string
}) {
  const { t } = useI18n()
  const row = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const [count, setCount] = useState(Math.min(5, items.length))
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const visibleCount = Math.min(count, items.length)

  useLayoutEffect(() => {
    const element = row.current
    if (!element) return
    const measure = () => {
      const width = element.clientWidth
      if (!width) return
      const gap = 6
      const prefixWidth = element.querySelector<HTMLElement>('.quick-prompt-overflow-prefix')?.offsetWidth || 0
      const widths = [...element.querySelectorAll<HTMLElement>('.quick-prompt-overflow-item')].map(item => item.offsetWidth)
      const available = width - 2 - (prefixWidth ? prefixWidth + gap : 0)
      const limit = Math.min(5, widths.length)
      const total = widths.reduce((sum, value) => sum + value + gap, -gap)
      const reserve = widths.length > limit || total > available ? (trigger.current?.offsetWidth || 80) + gap : 0
      let used = 0
      let next = 0
      while (next < limit && used + widths[next] <= available - reserve) {
        used += widths[next] + gap
        next++
      }
      setCount(next)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    element.querySelectorAll<HTMLElement>('.quick-prompt-overflow-item, .quick-prompt-overflow-prefix').forEach(item => observer?.observe(item))
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [items, prefix])

  useLayoutEffect(() => {
    if (!open) return
    if (visibleCount >= items.length) { setOpen(false); return }
    const anchor = trigger.current!.getBoundingClientRect()
    const bounds = card.current!.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, anchor.top >= bounds.height + 14 ? anchor.top - bounds.height - 6 : Math.min(anchor.bottom + 6, window.innerHeight - bounds.height - 8)),
    })
    const outside = (event: MouseEvent) => {
      if (!card.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    }
    const close = () => setOpen(false)
    document.addEventListener('mousedown', outside)
    window.addEventListener('keydown', escape)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', outside)
      window.removeEventListener('keydown', escape)
      window.removeEventListener('resize', close)
    }
  }, [open, visibleCount, items.length])

  return <>
    <div ref={row} className="chat-quick-prompts quick-prompt-overflow" role="group" aria-label={label}>
      {prefix && <div className="quick-prompt-overflow-prefix">{prefix}</div>}
      {items.map((item, index) => <div key={index} className="quick-prompt-overflow-item" data-overflow={index >= visibleCount}
        inert={index >= visibleCount} aria-hidden={index >= visibleCount || undefined}>{item}</div>)}
      <Button ref={trigger} size="sm" className="quick-prompt-overflow-more" data-hidden={visibleCount >= items.length}
        tabIndex={visibleCount >= items.length ? -1 : undefined} aria-hidden={visibleCount >= items.length || undefined}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t('common.quickPromptMore')}</Button>
    </div>
    {open && createPortal(<div ref={card} className="quick-prompt-overflow-card" role="dialog" aria-label={label || t('common.quickPromptMore')}
      style={position} onClick={event => {
        const target = event.target as Element
        if (target.closest('button:not(:disabled), a[href]')) setOpen(false)
      }}>{items.slice(visibleCount).map((item, index) => <div key={index} className="quick-prompt-overflow-option">{item}</div>)}</div>, document.body)}
  </>
}
