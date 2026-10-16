import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Task } from '../api/client'
import { useI18n } from '../i18n'
import Input from './Input'
import Icon from './Icon'
import './TaskPicker.css'

type PickerTask = Pick<Task, 'id' | 'title' | 'creator_name' | 'created_at'>

/** Search selects existing tasks only; IDs are retained as values, never labels. */
export default function TaskPicker({ tasks, value, onChange, label, disabled = false }: {
  tasks: PickerTask[]; value: string; onChange: (id: string) => void; label: string; disabled?: boolean
}) {
  const { t, locale } = useI18n()
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 280 })
  const selected = tasks.find(task => task.id === value)
  const visible = tasks.filter(task => `${task.title} ${task.creator_name || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const metadata = (task: PickerTask) => {
    const date = new Date(task.created_at)
    return `${task.creator_name?.trim() || t('common.unknown')} · ${Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale, { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}`
  }
  const close = () => { setOpen(false); setQuery('') }
  const show = () => { if (!disabled) { setOpen(true); setQuery(''); setCursor(Math.max(0, tasks.findIndex(task => task.id === value))) } }
  const choose = (task: PickerTask) => { onChange(task.id); close(); input.current?.focus() }
  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const rect = input.current?.getBoundingClientRect()
      if (!rect) return
      const below = window.innerHeight - rect.bottom - 8
      const above = rect.top - 8
      const maxHeight = Math.min(280, Math.max(0, below < 160 && above > below ? above : below))
      const width = Math.min(rect.width, Math.max(0, window.innerWidth - 16))
      setPosition({ width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: below < 160 && above > below ? rect.top - maxHeight - 4 : rect.bottom + 4, maxHeight })
    }
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !list.current?.contains(event.target)) reposition() }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', scroll, true)
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', scroll, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    list.current?.querySelectorAll<HTMLElement>('[role="option"]')[cursor]?.scrollIntoView?.({ block:'nearest' })
  }, [open, cursor])
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !list.current?.contains(event.target)) close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation(); close()
    }
    document.addEventListener('mousedown', outside)
    window.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('keydown', escape, true) }
  }, [open])
  return <div ref={root} className="task-picker">
    <div className="task-picker-input-row">
      <Input ref={input} role="combobox" aria-label={label} aria-autocomplete="list" aria-haspopup="listbox"
        aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open && visible[cursor] ? `${id}-${cursor}` : undefined}
        disabled={disabled} value={open ? query : selected?.title || (value ? t('schedules.taskUnavailable') : '')}
        placeholder={t('schedules.taskSearch')} onFocus={show} onClick={() => { if (!open) show() }}
        onBlur={() => close()} onChange={event => { setQuery(event.target.value); setCursor(0); setOpen(true); if (value) onChange('') }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) show()
            else setCursor(current => visible.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length : 0)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (open && visible[cursor]) choose(visible[cursor])
            else if (!open) show()
          }
        }} />
      <button type="button" className="task-picker-toggle" aria-label={t('schedules.selectTask')} disabled={disabled}
        onMouseDown={event => event.preventDefault()} onClick={() => { if (open) close(); else { input.current?.focus(); show() } }}><Icon name="chevron-down" size={14} /></button>
    </div>
    {selected && !open && <div className="task-picker-selected-meta">{metadata(selected)}</div>}
    {open && createPortal(<div ref={list} id={id} role="listbox" aria-label={label} className="task-picker-options" style={position}>
      {visible.map((task, index) => <button type="button" key={task.id} id={`${id}-${index}`} role="option" aria-selected={task.id === value}
        data-value={task.id} data-active={cursor === index} className="task-picker-option" tabIndex={-1}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setCursor(index)} onClick={() => choose(task)}>
        <span className="task-picker-title">{task.title}</span><span className="task-picker-meta">{metadata(task)}</span>
      </button>)}
      {!visible.length && <div className="task-picker-empty">{t('common.noMatchingOptions')}</div>}
    </div>, document.body)}
  </div>
}
