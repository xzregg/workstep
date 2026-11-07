import React, { Children, forwardRef, isValidElement, useEffect, useId, useRef, useState, type ReactNode, type SelectHTMLAttributes, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

type Option = { value: string; label: string; disabled: boolean; group: string; hidden: boolean }
export type SearchableSelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  loading?: boolean
  loadingLabel?: string
  placeholder?: string
  searchLabel?: string
  emptyLabel?: string
  openLabel?: string
  onSearchChange?: (query: string) => void
  cards?: boolean
  skinRole?: string
  compact?: boolean
  renderMobilePopup?: (children: ReactNode, close: () => void, title: string) => ReactNode
}

function text(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child)
    : isValidElement<{ children?: ReactNode }>(child) ? text(child.props.children) : '').join('')
}
function optionsOf(children: ReactNode, group = '', disabled = false): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; value?: string; label?: string; disabled?: boolean; hidden?: boolean }>(child)) return []
    if (child.type === React.Fragment) return optionsOf(child.props.children, group, disabled)
    if (child.type === 'optgroup') return optionsOf(child.props.children, child.props.label ?? '', disabled || !!child.props.disabled)
    if (child.type !== 'option') return []
    const label = child.props.label ?? text(child.props.children)
    return [{ value: String(child.props.value ?? label), label, disabled: disabled || !!child.props.disabled, group, hidden: !!child.props.hidden }]
  })
}

/** The native element is a hidden form adapter; only the application popup is interactive. */
export const SearchableSelect = forwardRef<HTMLSelectElement, SearchableSelectProps>(function SearchableSelect({
  children, className, searchLabel = '搜索选项', emptyLabel = '没有匹配的选项', openLabel = '选择',
  onSearchChange, cards, skinRole, compact = false, renderMobilePopup, loading, loadingLabel = '正在加载…', placeholder, ...rest
}, ref) {
  const native = useRef<HTMLSelectElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  const generatedId = useId(), listId = generatedId + '-options'
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [cursor, setCursor] = useState(0)
  const [label, setLabel] = useState(''), [revision, refresh] = useState(0)
  const [position, setPosition] = useState({ left: 8, top: 8, width: 240, maxHeight: 320 })
  const options = optionsOf(children)
  const selected = rest.multiple
    ? Array.from(native.current?.selectedOptions ?? [], option => option.value)
    : [String(rest.value ?? native.current?.value ?? rest.defaultValue ?? options[0]?.value ?? '')]
  const values = rest.multiple && Array.isArray(rest.value) ? rest.value.map(String) : selected
  const visible = options.filter(option => !option.hidden && (!!onSearchChange || option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
  const active = visible[cursor]
  const close = (focus = true) => { setOpen(false); setQuery(''); if (focus) trigger.current?.focus() }
  const closeRef = useRef(close)
  closeRef.current = close
  const show = () => {
    if (rest.disabled || native.current?.matches(':disabled')) return
    setQuery(''); setCursor(Math.max(0, options.filter(option => !option.hidden).findIndex(option => values.includes(option.value))))
    trigger.current?.focus(); setOpen(true)
    onSearchChange?.('')
  }
  useEffect(() => {
    const element = native.current
    if (!element) return
    setLabel(rest['aria-label'] || Array.from(element.labels ?? [], item => {
      const clone = item.cloneNode(true) as HTMLElement
      clone.querySelectorAll('select, button, input').forEach(node => node.remove())
      return clone.textContent?.trim() ?? ''
    }).join(' ') || rest.title || openLabel)
  }, [rest['aria-label'], rest.title, openLabel, children])
  useEffect(() => { if (rest.disabled) setOpen(false) }, [rest.disabled])
  useEffect(() => {
    if (!open) return
    const element = panel.current
    if (!element) return
    if (!compact && typeof element.showPopover === 'function') element.showPopover()
    const measure = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect || compact) return
      const width = Math.min(Math.max(240, rect.width), window.innerWidth - 16)
      const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12
      const maxHeight = Math.max(80, Math.min(360, Math.max(below, above)))
      const height = Math.min(element.scrollHeight || 280, maxHeight)
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: below >= height ? rect.bottom + 4 : Math.max(8, rect.top - height - 4), width, maxHeight })
    }
    const outside = (event: Event) => {
      const target = event.target as Node
      if (!element.contains(target) && !trigger.current?.contains(target)) closeRef.current(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation(); closeRef.current()
    }
    measure(); search.current?.focus()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true)
    return () => {
      if (!compact && typeof element.hidePopover === 'function' && element.isConnected) element.hidePopover()
      observer?.disconnect(); document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true)
    }
  }, [open, compact])
  useEffect(() => {
    if (open) document.getElementById(listId + '-' + cursor)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, cursor, listId])
  function choose(option: Option) {
    const element = native.current
    if (!element || option.disabled || rest.disabled || element.matches(':disabled')) return
    if (rest.multiple) {
      for (const item of element.options) if (item.value === option.value) item.selected = !values.includes(option.value)
    } else element.value = option.value
    if (rest.multiple || !values.includes(option.value)) {
      element.dispatchEvent(new window.Event('change', { bubbles: true }))
      refresh(revision + 1)
    }
    if (!rest.multiple) close()
  }
  function keys(event: KeyboardEvent) {
    if (event.key === 'Tab') { close(); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if ((event.key === 'Home' || event.key === 'End') && event.target === search.current) return
      event.preventDefault()
      let next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : cursor + (event.key === 'ArrowUp' ? -1 : 1)
      const direction = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1
      while (next >= 0 && next < visible.length && visible[next].disabled) next += direction
      if (next >= 0 && next < visible.length) setCursor(next)
    }
    if (event.key === 'Enter') { event.preventDefault(); if (active) choose(active) }
  }
  const popup = <div ref={panel} popover={!compact ? 'manual' : undefined} className={'skin-select-panel' + (compact ? ' skin-select-panel--sheet' : '')} style={!compact ? position : undefined} onKeyDown={keys}>
    <input ref={search} type="search" className="skin-select-search" role="combobox" aria-label={`${searchLabel} · ${label}`}
      aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={active ? listId + '-' + cursor : undefined}
      value={query} placeholder={searchLabel} onChange={event => { setQuery(event.target.value); setCursor(0); onSearchChange?.(event.target.value) }} />
    <div id={listId} role="listbox" aria-label={label} aria-multiselectable={rest.multiple || undefined}
      className={'skin-select-options' + (cards ? ' skin-select-options--cards' : '')}>
      {visible.map((option, index) => <React.Fragment key={option.value + ':' + index}>
        {option.group && (index === 0 || visible[index - 1].group !== option.group) && <div className="skin-select-group">{option.group}</div>}
        <button type="button" id={listId + '-' + index} role="option" aria-selected={values.includes(option.value)} tabIndex={-1}
          disabled={option.disabled} data-value={option.value} data-focused={index === cursor} className="skin-select-option"
          onMouseEnter={() => setCursor(index)} onClick={() => choose(option)}>{option.label}</button>
      </React.Fragment>)}
      {loading && <p role="status" className="skin-select-empty">{loadingLabel}</p>}
      {!loading && !visible.length && <p className="skin-select-empty">{emptyLabel}</p>}
    </div>
  </div>
  return <>
    <select {...rest} ref={node => { native.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node }}
      className="skin-select-native" onMouseDown={event => event.preventDefault()}
      onClick={event => { event.preventDefault(); trigger.current?.click() }} aria-hidden="true" tabIndex={-1} onFocus={event => { trigger.current?.focus(); rest.onFocus?.(event) }}>{children}</select>
    <button ref={trigger} type="button" role="combobox" aria-label={`${openLabel} ${label}`} title={rest.title}
      aria-expanded={open} aria-busy={loading || undefined} aria-controls={open ? listId : undefined} aria-haspopup="listbox" data-skin-role={skinRole}
      disabled={rest.disabled} className={['ws-select', 'skin-select-trigger', className].filter(Boolean).join(' ')} style={rest.style}
      onClick={() => open ? close() : show()} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show() } }}>
      <span className="skin-select-value">{options.filter(option => values.includes(option.value)).map(option => option.label).join('、') || values.join('、') || placeholder}</span>
      <span className="skin-select-chevron" aria-hidden="true">▾</span>
    </button>
    {open && (compact && renderMobilePopup ? renderMobilePopup(popup, () => close(), label)
      : createPortal(popup, trigger.current?.closest('dialog[open]') ?? document.body))}
  </>
})
