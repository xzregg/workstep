import { useState } from 'react'
import type { PermissionDefinition } from './PermissionDialogs'

export function PermissionSelection({ catalog, selected, scopes, disabled, onChange }: {
  catalog: PermissionDefinition[]; selected: string[]; scopes: string[]; disabled: boolean
  onChange: (permissions: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const keyword = query.trim().toLowerCase()
  const visible = catalog.filter(item => `${item.name} ${item.id} ${item.category}`.toLowerCase().includes(keyword))
  return <fieldset className="gateway-permission-selection" disabled={disabled}>
    <legend>权限（可多选）</legend>
    <div className="gateway-permission-selection-toolbar">
      <input type="search" aria-label="搜索权限" placeholder="搜索权限名称或关键词" value={query}
        onChange={event => setQuery(event.target.value)} />
      <span className="gateway-permission-count">{`已选 ${selected.length} 项`}</span>
      <button type="button" className="gateway-permission-clear" disabled={!selected.length}
        onClick={() => onChange([])}>清空选择</button>
    </div>
    <p className="gateway-permission-note">多项权限共用授权对象、作用范围和规则；范围不兼容的权限需分次分配。</p>
    {selected.length > 0 && <div className="gateway-permission-selected" aria-label="已选权限">
      {catalog.filter(item => selected.includes(item.id)).map(item => <button key={item.id} type="button"
        aria-label={`移除${item.name}`} onClick={() => onChange(selected.filter(id => id !== item.id))}>
        {item.name}<span aria-hidden="true">×</span>
      </button>)}
    </div>}
    <div className="gateway-permission-categories">
      {[...new Set(visible.map(item => item.category))].map(category => {
        const items = visible.filter(item => item.category === category)
        return <section className="gateway-permission-category" key={category} aria-label={category}>
          <div className="gateway-permission-category-heading"><h4>{category}</h4><span>{items.length} 项</span></div>
          <div className="gateway-permission-options">{items.map(item => {
            const checked = selected.includes(item.id)
            const incompatible = !checked && selected.length > 0 && !item.scopes.some(scope => scopes.includes(scope))
            return <label key={item.id} className={`gateway-permission-option${checked ? ' is-selected' : ''}${incompatible ? ' is-unavailable' : ''}`}>
              <input type="checkbox" aria-label={item.name} checked={checked} disabled={incompatible}
                onChange={event => onChange(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />
              <span>{item.name}{incompatible && <small>与已选权限范围不兼容</small>}</span>
            </label>
          })}</div>
        </section>
      })}
    </div>
    {!visible.length && <p className="gateway-permission-empty">没有匹配的权限，请尝试其他关键词。</p>}
  </fieldset>
}
