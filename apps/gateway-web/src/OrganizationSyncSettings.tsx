import { useEffect, useRef, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { AdminRecordTable } from './AdminRecordTable'

type Application = { id: string; provider: 'dingtalk' | 'wecom'; tenant_id: string; client_id: string; agent_id?: string;
 enabled: boolean; login_enabled?: boolean; sync_enabled?: boolean; secret_configured?: boolean;
 sync_state?: { last_success_at: string | null; last_error_code: string | null } }
const names = { dingtalk: '钉钉', wecom: '企业微信' }

function ApplicationEditor({ provider, source, csrf, onClose, onSaved }: { provider: Application['provider']; source?: Application; csrf: string; onClose: () => void; onSaved: () => void }) {
 const initial = { tenant: source?.tenant_id ?? '', client: source?.client_id ?? '', agent: source?.agent_id ?? '', secret: '',
  login: source?.login_enabled ?? true, sync: source?.sync_enabled ?? true, enabled: source?.enabled ?? true }
 const [draft, setDraft] = useState(initial)
 const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [discard, setDiscard] = useState(false)
 const submitting = useRef(false)
 const valid = !!(csrf && draft.tenant.trim() && (provider === 'wecom' ? draft.agent.trim() : draft.client.trim()) && (source || draft.secret))
 const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
 const change = (key: keyof typeof draft, value: string | boolean) => setDraft(current => ({ ...current, [key]: value }))
 async function save() {
  if (!valid || submitting.current) return
  submitting.current = true; setBusy(true); setError('')
  try {
   const response = await fetch('/api/admin/identity-sources' + (source ? '/' + encodeURIComponent(source.id) : ''), {
    method: source ? 'PUT' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ provider, tenant_id: draft.tenant.trim(), client_id: provider === 'wecom' ? draft.tenant.trim() : draft.client.trim(), agent_id: provider === 'wecom' ? draft.agent.trim() : null,
     client_secret: draft.secret || null, enabled: draft.enabled, login_enabled: draft.login, sync_enabled: draft.sync }),
   })
   if (!response.ok) throw Error(response.status === 409 ? '该企业应用已存在，请编辑已有配置。' : '保存应用配置失败，请重试。')
   onSaved()
  } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败。') }
  finally { submitting.current = false; setBusy(false) }
 }
 return <><GatewayConfirmDialog title={names[provider] + '应用配置'} message="配置企业应用并选择组织同步及扫码登录。" confirmLabel="保存配置" disabled={!valid} busy={busy} onConfirm={() => void save()} onCancel={() => dirty ? setDiscard(true) : onClose()}>
  <div className="gateway-application-fields">
   <label>Corp ID<input value={draft.tenant} disabled={busy || !!source} onChange={event => change('tenant', event.target.value)} /></label>
   {provider === 'dingtalk' && <label>App Key / Client ID<input value={draft.client} disabled={busy} onChange={event => change('client', event.target.value)} /></label>}
   {provider === 'wecom' && <label>Agent ID<input value={draft.agent} disabled={busy} onChange={event => change('agent', event.target.value)} /></label>}
   <label>应用 Secret<input type="password" autoComplete="new-password" value={draft.secret} disabled={busy} placeholder={source ? '留空保留已保存的密钥' : '请输入应用密钥'} onChange={event => change('secret', event.target.value)} /></label>
   <label className="gateway-check-label"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => change('enabled', event.target.checked)} />启用应用</label>
   <label className="gateway-check-label"><input type="checkbox" checked={draft.sync} disabled={busy} onChange={event => change('sync', event.target.checked)} />启用组织同步</label>
   <label className="gateway-check-label"><input type="checkbox" checked={draft.login} disabled={busy} onChange={event => change('login', event.target.checked)} />启用扫码登录</label>
  </div>
  <p>密钥加密保存，保存后不再回显。请在企业应用后台授权通讯录读取权限，并配置本平台的登录回调域。</p>
  {source && <label>登录回调地址<input readOnly value={window.location.origin + '/api/auth/external/' + source.id + '/callback'} /></label>}
  {error && <p role="alert" className="gateway-auth-error">{error}</p>}
 </GatewayConfirmDialog>
 {discard && <GatewayConfirmDialog title="放弃应用配置" message="尚未保存的修改将丢失。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}</>
}

export function OrganizationSyncSettings({ csrf }: { csrf: string }) {
 const [sources, setSources] = useState<Application[]>([])
 const [page, setPage] = useState(1); const [total, setTotal] = useState(0)
 const [revision, setRevision] = useState(0); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
 const [loading, setLoading] = useState(true); const [busy, setBusy] = useState('')
 const [editor, setEditor] = useState<{ provider: Application['provider']; source?: Application } | null>(null)
 const syncing = useRef(false)
 useEffect(() => {
  const controller = new AbortController(); setLoading(true); setError('')
  void fetch(`/api/admin/identity-sources?page=${page}&page_size=25`, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
   if (!response.ok) throw Error('企业应用配置加载失败。')
   const result = await response.json(); if (!controller.signal.aborted) { setSources(result.sources ?? []); setTotal(result.total ?? result.sources?.length ?? 0) }
  }).catch(() => { if (!controller.signal.aborted) setError('企业应用配置加载失败，请重试。') }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
  return () => controller.abort()
 }, [revision, page])
 async function sync(source: Application) {
  if (syncing.current || !csrf) return
  syncing.current = true; setBusy(source.id); setError(''); setNotice('')
  try {
   const response = await fetch('/api/admin/identity-sources/' + encodeURIComponent(source.id) + '/reconcile', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } })
   if (!response.ok) throw Error('同步失败，请检查应用密钥、通讯录权限和服务网络后重试。')
   setNotice(names[source.provider] + '组织同步完成，已更新用户组和用户。'); setRevision(value => value+1)
  } catch (reason) { setError(reason instanceof Error ? reason.message : '同步失败。') }
  finally { syncing.current = false; setBusy('') }
 }
 return <section className="gateway-project-grants gateway-organization-settings"><div className="gateway-admin-toolbar"><h3>组织同步与扫码登录</h3>
  <div className="gateway-device-actions"><button type="button" disabled={!csrf || !!busy} onClick={() => setEditor({ provider: 'dingtalk' })}>添加钉钉应用</button><button type="button" disabled={!csrf || !!busy} onClick={() => setEditor({ provider: 'wecom' })}>添加企业微信应用</button></div>
 </div><p>同步将按企业部门层级创建用户组及成员；启用扫码登录后，对应入口会出现在平台登录页。</p>
 {loading && <p role="status"><span className="gateway-spinner" /> 正在加载企业应用…</p>}
 {error && <p role="alert" className="gateway-auth-error">{error}<button type="button" onClick={() => setRevision(value => value+1)}>重试</button></p>}
 {notice && <p role="status">{notice}</p>}
 <AdminRecordTable columns={['应用', '组织同步', '扫码登录', '最近同步', '操作']}>{sources.map(source => <tr key={source.id}>
  <td><strong>{names[source.provider]}</strong><p>{source.tenant_id}</p><small>{source.secret_configured ? '密钥已配置' : '请配置密钥'}{source.enabled ? '' : ' · 应用已停用'}</small></td>
  <td>{source.sync_enabled === false ? '关闭' : '启用'}</td><td>{source.login_enabled === false ? '关闭' : '启用'}</td>
  <td>{source.sync_state?.last_success_at ? new Date(source.sync_state.last_success_at).toLocaleString() : '尚未同步'}{source.sync_state?.last_error_code && <p>最近同步失败</p>}</td>
  <td><div className="gateway-device-actions"><button type="button" disabled={!!busy} onClick={() => setEditor({ provider: source.provider, source })}>编辑配置</button>
   <button type="button" disabled={!csrf || !!busy || !source.enabled || source.sync_enabled === false} onClick={() => void sync(source)}>{busy === source.id && <span className="gateway-spinner" />}{busy === source.id ? '正在同步…' : '同步组织'}</button></div></td>
 </tr>)}</AdminRecordTable>
 {!loading && !sources.length && <p>尚未配置企业应用。</p>}
 {total > 25 && <div className="gateway-admin-pagination"><span>共 {total} 个应用 · 第 {page}/{Math.ceil(total/25)} 页</span><button type="button" disabled={loading || !!busy || page <= 1} onClick={() => setPage(value => value-1)}>上一页</button><button type="button" disabled={loading || !!busy || page*25 >= total} onClick={() => setPage(value => value+1)}>下一页</button></div>}
 {editor && <ApplicationEditor {...editor} csrf={csrf} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setPage(1); setRevision(value => value+1) }} />}
 </section>
}
