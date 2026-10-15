import * as React from 'react'

export function TaskShareLoginToggle({ checked, required = false, onChange, label, hint }: {
  checked: boolean; required?: boolean; onChange: (value: boolean) => void; label: string; hint: string
}): React.JSX.Element {
  return <div className="task-share-login-control">
    <label className="task-share-login-toggle">
      <input type="checkbox" checked={checked} disabled={required} aria-label={label}
        onChange={event => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
    {checked && <p>{hint}</p>}
  </div>
}
