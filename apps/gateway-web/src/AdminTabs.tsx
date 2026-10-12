import { useId, useRef, useState, type ReactNode } from 'react'

type Tab = { id: string; label: string; content: ReactNode }

/** Mount panels on first visit, then retain their drafts while another tab is visible. */
export function AdminTabs({ label, items, value, onChange }: {
 label: string; items: Tab[]; value?: string; onChange?: (id: string) => void
}) {
 const prefix = useId()
 const [selected, setSelected] = useState(items[0]?.id ?? '')
 const current = value ?? selected
 const [visited, setVisited] = useState<string[]>([current])
 const buttons = useRef<Map<string, HTMLButtonElement>>(new Map())
 function choose(id: string) {
  setVisited(previous => [...new Set([...previous, current, id])])
  if (value === undefined) setSelected(id)
  onChange?.(id)
 }
 return <div className="gateway-admin-tabs">
  <div className="gateway-admin-tablist" role="tablist" aria-label={label}>
   {items.map((item, index) => <button key={item.id} type="button" role="tab"
    id={`${prefix}-tab-${item.id}`} aria-controls={`${prefix}-panel-${item.id}`}
    aria-selected={current === item.id} tabIndex={current === item.id ? 0 : -1}
    ref={node => { if (node) buttons.current.set(item.id, node); else buttons.current.delete(item.id) }}
    onClick={() => choose(item.id)} onKeyDown={event => {
     let next: number
     if (event.key === 'ArrowRight') next = (index + 1) % items.length
     else if (event.key === 'ArrowLeft') next = (index + items.length - 1) % items.length
     else if (event.key === 'Home') next = 0
     else if (event.key === 'End') next = items.length - 1
     else return
     event.preventDefault()
     choose(items[next].id)
     buttons.current.get(items[next].id)?.focus()
    }}>{item.label}</button>)}
  </div>
  {items.map(item => <div key={item.id} role="tabpanel" className="gateway-admin-tabpanel"
   id={`${prefix}-panel-${item.id}`} aria-labelledby={`${prefix}-tab-${item.id}`}
   hidden={current !== item.id} tabIndex={0}>
   {(current === item.id || visited.includes(item.id)) && item.content}
  </div>)}
 </div>
}
