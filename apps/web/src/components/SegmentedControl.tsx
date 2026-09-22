import type { CSSProperties } from 'react'

interface SegmentedOption<T extends string> {
  value: T
  label: string
}

interface SegmentedControlProps<T extends string> {
  ariaLabel: string
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  style?: CSSProperties
}

export default function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  style,
}: SegmentedControlProps<T>) {
  return (
    <div
      className="segmented-control"
      role="group"
      aria-label={ariaLabel}
      style={style}
    >
      {options.map((option) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            className={selected ? 'is-selected' : undefined}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
