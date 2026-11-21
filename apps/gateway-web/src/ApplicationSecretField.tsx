import { localizeGatewayError } from './gatewayErrorText'
import { useEffect, useId, useRef, useState } from 'react'

export function ApplicationSecretField({ value, onChange, sourceId, configured, csrf, disabled }: {
  value: string; onChange: (value: string) => void; sourceId?: string; configured?: boolean; csrf: string; disabled: boolean
}) {
  const id = useId()
  const [saved, setSaved] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => { controller.current?.abort() }, [])
  const available = !!(value || saved || (sourceId && configured && csrf))
  async function act(copy: boolean) {
    if (pending.current || disabled || !available) return
    if (!copy && visible) { setVisible(false); return }
    pending.current = true; setBusy(true); setNotice(''); setError('')
    const request = new AbortController()
    controller.current = request
    try {
      let secret = value || saved
      if (!secret) {
        const response = await fetch(`/api/admin/identity-sources/${encodeURIComponent(sourceId!)}/secret/reveal`, {
          method: 'POST', credentials: 'same-origin', headers: {'X-CSRF-Token': csrf}, signal: request.signal,
        })
        if (!response.ok) throw Error('Failed to read the key. Please check permissions or key configuration and try again.')
        secret = (await response.json()).client_secret
        if (typeof secret !== 'string' || !secret) throw Error('The application has no readable key, please reconfigure.')
        if (request.signal.aborted) return
        setSaved(secret)
      }
      if (copy) {
        try { await navigator.clipboard.writeText(secret) }
        catch { throw Error('Copy failed. Please reveal the key and copy manually.') }
        if (!request.signal.aborted) setNotice('密钥已复制')
      } else setVisible(true)
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : 'Failed to read the key, please try again.')
    } finally {
      pending.current = false
      if (!request.signal.aborted) setBusy(false)
    }
  }
  return <div className="gateway-application-secret">
    <label htmlFor={id}>应用 Secret</label>
    <div className="gateway-application-secret-controls">
      <input id={id} type={visible ? 'text' : 'password'} autoComplete="new-password" value={value || saved || ''}
        disabled={disabled || busy} placeholder={sourceId ? '留空保留已保存的密钥' : '请输入应用密钥'}
        onChange={event => {setSaved(null); setNotice(''); setError(''); onChange(event.target.value)}} />
      <button type="button" disabled={disabled || busy || !available} aria-pressed={visible} onClick={() => void act(false)}>{visible ? '隐藏密钥' : '显示密钥'}</button>
      <button type="button" disabled={disabled || busy || !available} onClick={() => void act(true)}>复制密钥</button>
    </div>
    {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" />正在处理密钥…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="gateway-auth-error">{localizeGatewayError(error)}</p>}
  </div>
}
