import Input from './Input'

interface ConcurrencyLimitInputProps {
  id: string
  value: string
  unlimitedLabel: string
  onValueChange: (value: string) => void
}

/** Numeric concurrency input that presents zero as a user-facing unlimited label. */
export default function ConcurrencyLimitInput({
  id,
  value,
  unlimitedLabel,
  onValueChange,
}: ConcurrencyLimitInputProps) {
  const displayValue = value === '0' || value === '' ? unlimitedLabel : value

  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      pattern="[1-9][0-9]*"
      autoComplete="off"
      value={displayValue}
      onFocus={(event) => {
        if (value === '' || value === '0') event.currentTarget.select()
      }}
      onChange={(event) => {
        const next = event.target.value
        if (next === '' || next === '0') onValueChange('0')
        else if (/^[1-9]\d*$/.test(next)) onValueChange(next)
      }}
    />
  )
}
