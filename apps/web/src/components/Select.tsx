import { useOverlay } from '../hooks/useOverlay'
import { Children, Fragment, forwardRef, isValidElement, useEffect, useId, useRef, useState, type ReactNode, type SelectHTMLAttributes, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useActiveSkin, SKIN_EVENT } from '../skins/runtime'
import { resolvedSkinLayout } from '../skins/contract'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useI18n } from '../i18n'
import MobileSheet from './MobileSheet'
import './Select.css'

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { skinRole?: 'engine' }
interface Option { value: string; label: string; disabled: boolean; group: string; hidden: boolean }
function text(node: ReactNode): string {
  return Children.toArray(node).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? text(child.props.children) : '').join('')
}
function optionsOf(children: ReactNode, group = '', groupDisabled = false): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; value?: string; label?: string; disabled?: boolean; hidden?: boolean }>(child)) return []
    if (child.type === Fragment) return optionsOf(child.props.children, group, groupDisabled)
    if (child.type === 'optgroup') return optionsOf(child.props.children, child.props.label || '', Boolean(child.props.disabled))
    if (child.type !== 'option') return []
    const label = child.props.label || text(child.props.children)
    return [{ value: String(child.props.value ?? label), label, disabled: Boolean(groupDisabled || child.props.disabled), group, hidden: Boolean(child.props.hidden) }]
  })
}

/** Keeps native form/change semantics while skin popups are entirely application-rendered. */
export default forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, skinRole, ...rest }, ref,
) {
  const skin = useActiveSkin()
  const custom = skin.manifest.id !== 'default' && !rest.multiple && (!rest.size || rest.size === 1)
  const compact = useCompactLayout()
  const { t } = useI18n()
  const native = useRef<HTMLSelectElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const listId = useId()
  const typed = useRef({ value: '', at: 0 })
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [cursor, setCursor] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 240, maxHeight: 320 })
  const options = optionsOf(children)
  const selected = String(rest.value ?? native.current?.value ?? rest.defaultValue ?? options[0]?.value ?? '')
  const visible = options.filter(o => !o.hidden && o.label.toLowerCase().includes(query.toLowerCase()))
  const active = visible[cursor]
  const close = (focus = true) => { setOpen(false); setQuery(''); if (focus) trigger.current?.focus() }
  const show = () => {
    if (rest.disabled) return
    trigger.current?.focus()
    const index = options.filter(o => !o.hidden).findIndex(o => o.value === selected)
    setCursor(Math.max(0, index)); setQuery(''); setOpen(true)
  }
  useOverlay(open && custom && !compact, () => close(), panel, false, false)
  useEffect(() => {
    if (!open) return
    const measure = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(240, rect.width), window.innerWidth - 16)
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const maxHeight = Math.max(80, Math.min(360, Math.max(below, above)))
      const height = Math.min(panel.current?.scrollHeight || 320, maxHeight)
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: below >= height ? rect.bottom + 4 : Math.max(8, rect.top - height - 4), width, maxHeight })
    }
    const onSkin = () => close()
    measure(); panel.current?.focus()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (panel.current) observer?.observe(panel.current)
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true); window.addEventListener(SKIN_EVENT, onSkin)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); window.removeEventListener(SKIN_EVENT, onSkin) }
  }, [open, compact])
  useEffect(() => {
    if (open) document.getElementById(listId + '-' + cursor)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, cursor, listId])
  useEffect(() => { if (rest.disabled || !custom) setOpen(false) }, [rest.disabled, custom])
  const choose = (option: Option) => {
    if (option.disabled || rest.disabled || !native.current) return
    if (option.value !== selected) {
      native.current.value = option.value
      native.current.dispatchEvent(new window.Event('change', { bubbles: true }))
    }
    close()
  }
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') { close(); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      let next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : cursor + (event.key === 'ArrowDown' ? 1 : -1)
      const direction = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1
      while (next >= 0 && next < visible.length && visible[next].disabled) next += direction
      if (next >= 0 && next < visible.length) setCursor(next)
    }
    if (event.key === 'Enter' || (event.key === ' ' && event.target === event.currentTarget)) { event.preventDefault(); if (active) choose(active) }
    if (event.key.length === 1 && event.key !== ' ' && event.target === event.currentTarget) {
      typed.current.value = Date.now() - typed.current.at < 700 ? typed.current.value + event.key : event.key
      typed.current.at = Date.now()
      const next = visible.findIndex(option => !option.disabled && option.label.toLowerCase().startsWith(typed.current.value.toLowerCase()))
      if (next >= 0) setCursor(next)
    }
  }
  const list = <div ref={panel} id={listId} role="listbox" tabIndex={-1} aria-label={rest['aria-label'] || rest.title || t('skins.openSelect')} aria-activedescendant={active ? listId + '-' + cursor : undefined} className="skin-select-panel" style={!compact ? position : undefined} onKeyDown={keys}>
    {options.length > 7 && <input className="skin-select-search" value={query} placeholder={t('skins.search')} aria-label={t('skins.search')} onChange={event => { setQuery(event.target.value); setCursor(0) }} />}
    <div className={'skin-select-options' + (skinRole === 'engine' && resolvedSkinLayout(skin, compact).engineAppearance === 'cards' ? ' skin-select-options--cards' : '')}>
      {visible.map((option, index) => <Fragment key={option.value + ':' + index}>
        {option.group && (index === 0 || visible[index - 1].group !== option.group) && <div className="skin-select-group">{option.group}</div>}
        <button type="button" id={listId + '-' + index} role="option" aria-selected={option.value === selected} tabIndex={-1} disabled={option.disabled} data-value={option.value} data-focused={index === cursor} className="skin-select-option" onMouseEnter={() => setCursor(index)} onClick={() => choose(option)}>{option.label}</button>
      </Fragment>)}
      {!visible.length && <p className="skin-select-empty">{t('skins.noOptions')}</p>}
    </div>
  </div>
  return <>
    <select {...rest} ref={node => { native.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node }} className={['ws-select', className, custom ? 'skin-select-native' : ''].filter(Boolean).join(' ')} aria-hidden={custom || undefined} tabIndex={custom ? -1 : rest.tabIndex} onFocus={event => { if (custom) trigger.current?.focus(); rest.onFocus?.(event) }}>{children}</select>
    {custom && <button ref={trigger} type="button" role="combobox" aria-label={rest['aria-label']} aria-labelledby={rest['aria-labelledby']} title={rest.title} aria-expanded={open} aria-controls={open ? listId : undefined} aria-haspopup="listbox" data-skin-role={skinRole} disabled={rest.disabled} className={['ws-select', 'skin-select-trigger', className].filter(Boolean).join(' ')} style={rest.style} onClick={() => open ? close() : show()} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show() } }}>{options.find(o => o.value === selected)?.label || selected}<span aria-hidden="true">▾</span></button>}
    {open && custom && (compact ? <MobileSheet open title={rest['aria-label'] || t('skins.openSelect')} onClose={() => close()}>{list}</MobileSheet> : createPortal(<><div className="skin-select-backdrop" onClick={() => close()} />{list}</>, document.body))}
  </>
})
