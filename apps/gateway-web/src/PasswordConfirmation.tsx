import { createContext, useContext, useId, useState } from 'react'

// This policy comes from the server's current authenticated session.
export const PasswordConfirmationRequired = createContext(true)

export function useStepUpPassword() {
  const passwordRequired = useContext(PasswordConfirmationRequired)
  const [password, setPassword] = useState('')
  return { password, setPassword, passwordRequired, passwordReady: !passwordRequired || !!password }
}

export async function confirmStepUp(csrf: string, password: string, required: boolean) {
  if (!required) return { ok: true }
  return fetch('/api/auth/step-up', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ password }) })
}

export function PasswordConfirmation({ label, id, value, onChange, disabled = false }: {
  label: string; id?: string; value: string; onChange: (value: string) => void; disabled?: boolean
}) {
  const generated = useId()
  const required = useContext(PasswordConfirmationRequired)
  if (!required) return null
  const inputId = id ?? generated
  const input = <input id={inputId} type="password" autoComplete="current-password" value={value}
      disabled={disabled} onChange={event => onChange(event.target.value)} />
  return id ? <><label htmlFor={inputId}>{label}</label>{input}</> : <label htmlFor={inputId}>{label}{input}</label>
}
