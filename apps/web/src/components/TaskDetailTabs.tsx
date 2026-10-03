import type { ReactNode } from 'react'

export interface TaskTab<T extends string | number> {
  id: T
  label: ReactNode
}

interface TaskDetailTabsProps<T extends string | number> {
  tabs: readonly TaskTab<T>[]
  selected: T
  onSelect: (tab: T) => void
  className: string
  ariaLabel?: string
  actions?: ReactNode
}

/** Shared keyboard and selection semantics for detail, mobile, and artifact round tabs. */
export default function TaskDetailTabs<T extends string | number>({
  tabs, selected, onSelect, className, ariaLabel, actions,
}: TaskDetailTabsProps<T>) {
  const tablist = (
    <div className={className} role="tablist" aria-label={ariaLabel}>
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={selected === id}
          tabIndex={selected === id ? 0 : -1}
          onClick={() => onSelect(id)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const index = tabs.findIndex((tab) => tab.id === id)
            const offset = event.key === 'ArrowRight' ? 1 : -1
            const next = tabs[(index + offset + tabs.length) % tabs.length]
            onSelect(next.id)
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [(index + offset + tabs.length) % tabs.length]?.focus()
          }}
        >{label}</button>
      ))}
    </div>
  )
  return actions ? <div className={`${className}-row`}>
    {tablist}
    <div className={`${className}-actions`}>{actions}</div>
  </div> : tablist
}
