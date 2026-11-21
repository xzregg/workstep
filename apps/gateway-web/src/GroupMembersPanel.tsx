import { localizeGatewayError } from './gatewayErrorText'
import { useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Member = { user_id: string; username: string; display_name: string;
  role: 'member' | 'leader'; source: string }

export function GroupMembersPanel({ groupId, csrf }: { groupId: string; csrf: string }) {
  const [members, setMembers] = useState<Member[]>([])
  const [username, setUsername] = useState('')
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [remove, setRemove] = useState<Member | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/groups/${groupId}/members`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('Failed to load group members.')
      const result = await response.json()
      if (!controller.signal.aborted) setMembers(result.members ?? [])
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Failed to load group members.')
    })
    return () => controller.abort()
  }, [groupId, revision])

  async function change(method: 'POST' | 'DELETE', member?: Member) {
    if (!csrf || busy) return
    setBusy(true); setError('')
    const url = `/api/groups/${groupId}/members${member ? `/${member.user_id}` : ''}`
    try {
      const response = await fetch(url, { method, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: method === 'POST' ? JSON.stringify({ username: username.trim(), role: 'member' }) : undefined })
      if (!response.ok) throw new Error(response.status === 404
        ? 'The username does not exist or the account is unavailable.' : response.status === 409
          ? 'Directory sync members can only be managed by directory management.' : 'Failed to perform group member operation.')
      if (method === 'POST') setUsername('')
      setRemove(null)
      setRevision(value => value + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to perform group member operation.')
    } finally { setBusy(false) }
  }

  return <section className="gateway-overview-card"><h3>本组成员</h3>
    <p>组长可按准确用户名添加普通成员；组长任命和目录同步成员由管理员处理。</p>
    <div className="gateway-usage-filters"><label>成员用户名<input value={username} maxLength={64}
      onChange={event => setUsername(event.target.value)} placeholder="例如 alice" /></label>
      <button type="button" disabled={!csrf || busy || !/^[a-z][a-z0-9_-]{2,63}$/.test(username.trim())}
        onClick={() => void change('POST')}>添加普通成员</button></div>
    {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在更新成员…</p>}
    {error && <p role="alert" className="gateway-auth-error">{localizeGatewayError(error)} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {members.length === 0 ? <p>本组尚无成员。</p> : <ul>{members.map(member => <li key={member.user_id}>
      {member.username} · {member.role === 'leader' ? '组长' : '普通成员'}
      {member.source === 'manual' && member.role === 'member' && <button type="button" disabled={busy}
        onClick={() => setRemove(member)}>移除 {member.username}</button>}
    </li>)}</ul>}
    {remove && <GatewayConfirmDialog title="移除普通成员"
      message={`确认从本组移除“${remove.username}”？其组策略授权会立即失效。`}
      confirmLabel="确认移除" busy={busy} onCancel={() => setRemove(null)}
      onConfirm={() => void change('DELETE', remove)} />}
  </section>
}
