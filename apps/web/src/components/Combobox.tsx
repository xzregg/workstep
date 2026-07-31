import { useState, useRef, useEffect, useCallback } from 'react'

interface ComboboxProps {
  value: string
  options: readonly string[]
  onChange: (val: string) => void
  placeholder?: string
  style?: React.CSSProperties
}

/** 下拉框：点击展开全部选项，也支持自由输入自定义值 */
export default function Combobox({ value, options, onChange, placeholder, style }: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [inputVal, setInputVal] = useState(value)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setInputVal(value)
  }, [value])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const commit = useCallback((val: string) => {
    setInputVal(val)
    onChange(val)
    setOpen(false)
  }, [onChange])

  const toggle = useCallback(() => {
    setOpen(o => !o)
  }, [])

  return (
    <div ref={containerRef} style={{ position: 'relative', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
        <input
          ref={inputRef}
          value={inputVal}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setInputVal(e.target.value)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commit(inputVal) }
            if (e.key === 'Escape') { setInputVal(value); setOpen(false) }
          }}
          style={{ flex: 1, height: '100%', fontSize: 'inherit', border: 'none', outline: 'none', background: 'transparent', padding: '0 4px', minWidth: 0 }}
        />
        <span
          onMouseDown={(e) => { e.preventDefault(); toggle() }}
          style={{ cursor: 'pointer', padding: '0 4px', fontSize: 10, color: 'var(--meta)', userSelect: 'none', lineHeight: 1 }}
        >▼</span>
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
          maxHeight: 180, overflowY: 'auto',
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        }}>
          {options.map(opt => (
            <div
              key={opt}
              onMouseDown={(e) => { e.preventDefault(); commit(opt) }}
              style={{
                padding: '4px 8px', fontSize: 12, cursor: 'pointer',
                background: opt === value ? 'var(--accent-light, #e6f0ff)' : undefined,
              }}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
