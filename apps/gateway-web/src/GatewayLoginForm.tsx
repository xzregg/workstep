import { useState } from 'react'
import type { FormEvent } from 'react'

type Props = {
  busy?: boolean
  submitLabel?: string
  onSubmit: (username: string, password: string) => Promise<void>
}

export function GatewayLoginForm({ busy = false, submitLabel = '登录', onSubmit }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!username.trim() || !password || busy) return
    await onSubmit(username.trim(), password)
    setPassword('')
  }

  return <form onSubmit={(event) => void submit(event)} className="gateway-auth-form">
    <label htmlFor="gateway-username">用户名</label>
    <input id="gateway-username" autoComplete="username" value={username}
      onChange={(event) => setUsername(event.target.value)} />
    <label htmlFor="gateway-password">密码</label>
    <input id="gateway-password" type="password" autoComplete="current-password" value={password}
      onChange={(event) => setPassword(event.target.value)} />
    <button type="submit" disabled={busy || !username.trim() || !password}>{submitLabel}</button>
  </form>
}
