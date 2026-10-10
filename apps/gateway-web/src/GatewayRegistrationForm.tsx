import { passwordRequirements } from './portalAccount'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { validPortalAccount } from './portalAccount'
import type { RegistrationMode } from './portalAccount'

type Props = {
  mode: RegistrationMode
  onRegistered: (pending: boolean) => void
  onClosed: () => void
  onBack: () => void
}

export function GatewayRegistrationForm({ mode, onRegistered, onClosed, onBack }: Props) {
  const [account, setAccount] = useState({ username: '', display_name: '', password: '' })
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [closed, setClosed] = useState(false)
  const submitting = useRef(false)
  const valid = validPortalAccount(account.username, account.display_name, account.password)
    && confirmation === account.password

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!valid || closed || mode === 'closed' || submitting.current) return
    submitting.current = true
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(account),
      })
      if (response.status === 201 || response.status === 202) {
        onRegistered(response.status === 202)
        return
      }
      if (response.status === 403) {
        setClosed(true); onClosed()
        setError('平台已关闭注册，请联系管理员创建账号。')
      } else if (response.status === 409) {
        setError('用户名已被使用，请更换用户名后重试。')
      } else if (response.status === 429) {
        setError('尝试次数过多，请稍后再试。')
      } else if (response.status === 422) {
        setError('填写内容不符合要求，请检查用户名、显示名称和密码。')
      } else {
        setError('注册服务暂时不可用，请稍后重试。')
      }
    } catch {
      setError('网络连接失败，请检查连接后重试。')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return <form className="gateway-auth-form" onSubmit={event => void submit(event)} aria-busy={busy}>
    <label htmlFor="portal-username">用户名</label>
    <input id="portal-username" autoComplete="username" required maxLength={64} disabled={busy}
      aria-describedby="portal-username-hint" value={account.username}
      onChange={event => setAccount({ ...account, username: event.target.value })} />
    <p className="gateway-auth-hint" id="portal-username-hint">3–64 位，以小写字母开头，可含数字、下划线和连字符。</p>
    <label htmlFor="portal-display-name">显示名称</label>
    <input id="portal-display-name" required maxLength={256} disabled={busy} value={account.display_name}
      onChange={event => setAccount({ ...account, display_name: event.target.value })} />
    <label htmlFor="portal-password">密码（至少 8 位）</label>
    <input id="portal-password" type="password" autoComplete="new-password" required minLength={8}
      maxLength={128} disabled={busy} value={account.password}
      onChange={event => setAccount({ ...account, password: event.target.value })} />
    <p>{passwordRequirements}</p>
    <label htmlFor="portal-password-confirmation">确认密码</label>
    <input id="portal-password-confirmation" type="password" autoComplete="new-password" required
      maxLength={128} disabled={busy} value={confirmation}
      aria-invalid={!!confirmation && confirmation !== account.password}
      aria-describedby={confirmation && confirmation !== account.password ? 'portal-confirmation-hint' : undefined}
      onChange={event => setConfirmation(event.target.value)} />
    {confirmation && confirmation !== account.password && <p className="gateway-auth-hint gateway-auth-error"
      id="portal-confirmation-hint">两次输入的密码不一致。</p>}
    {mode === 'open_with_approval' && <p>提交后需等待管理员审核。</p>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    <button type="submit" disabled={busy || !valid || closed || mode === 'closed'}>
      {busy && <span className="gateway-spinner" aria-hidden="true" />}{busy ? '正在提交…' : '注册'}
    </button>
    <button className="gateway-auth-text-button" type="button" disabled={busy} onClick={onBack}>返回登录</button>
  </form>
}
