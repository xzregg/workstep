import { useId } from 'react'
import './RadioCardGroup.css'

export default function RadioCardGroup({ label, value, options, disabled, required, variant, onChange }: {
  label: string; value: string; disabled?: boolean; required?: boolean
  variant?: 'compact'
  options: readonly { value: string; label: string; description?: string }[]
  onChange: (value: string) => void
}) {
  const name = useId()
  return <fieldset className="radio-card-group" disabled={disabled} data-count={options.length} data-variant={variant}>
    <legend className={variant === 'compact' ? 'field-label' : undefined}>{label}{required && <span className="field-required" aria-hidden="true">*</span>}</legend>
    <div className="radio-card-options">
      {options.map(option => <label className="radio-card-option" key={option.value} data-checked={value === option.value || undefined}>
        <input type="radio" name={name} value={option.value} checked={value === option.value} required={required}
          onChange={() => onChange(option.value)} />
        <span><strong>{option.label}</strong>{option.description && <span className="radio-card-description">{option.description}</span>}</span>
      </label>)}
    </div>
  </fieldset>
}
