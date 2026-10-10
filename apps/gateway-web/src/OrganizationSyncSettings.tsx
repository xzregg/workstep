import { OrganizationSyncNotice } from './OrganizationSyncNotice'
import { useEffect, useRef, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { AdminRecordTable } from './AdminRecordTable'
import { OrganizationSyncHistory } from './OrganizationSyncHistory'
import { OrganizationSyncPanel } from './OrganizationSyncPanel'

type Application = { id: string; provider: 'dingtalk' | 'wecom'; tenant_id: string; client_id: string; agent_id?: string;
 enabled: boolean; login_enabled?: boolean; sync_enabled?: boolean; secret_configured?: boolean;
 sync_schedule?: {frequency: 'off' | 'daily' | 'weekly'; time?: string; timezone?: string; weekday?: number}; next_sync_at?: string | null;
 sync_state?: { last_success_at: string | null; last_error_code: string | null } }
const names = { dingtalk: '钉钉', wecom: '企业微信' }

function ApplicationEditor({ provider, source, csrf, platformAddress, onClose, onSaved }: { platformAddress?: string | null; provider: Application['provider']; source?: Application; csrf: string; onClose: () => void; onSaved: () => void }) {
 const initial = { tenant: source?.tenant_id ?? '', client: source?.client_id ?? '', agent: source?.agent_id ?? '', secret: '',
  frequency: source?.sync_schedule?.frequency ?? 'off', time: source?.sync_schedule?.time ?? '09:00', zone: source?.sync_schedule?.timezone ?? 'Asia/Shanghai', weekday: String(source?.sync_schedule?.weekday ?? 0),
  login: source?.login_enabled ?? true, sync: source?.sync_enabled ?? true, enabled: source?.enabled ?? true }
 const [draft, setDraft] = useState(initial)
 const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [discard, setDiscard] = useState(false)
 const submitting = useRef(false)
 const valid = !!(csrf && draft.tenant.trim() && (provider === 'wecom' ? draft.agent.trim() : draft.client.trim()) && (source || draft.secret) && (draft.frequency === 'off' || (draft.time && draft.zone.trim())))
 const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
 const change = (key: keyof typeof draft, value: string | boolean) => setDraft(current => ({ ...current, [key]: value }))
 async function save() {
  if (!valid || submitting.current) return
  submitting.current = true; setBusy(true); setError('')
  try {
   const response = await fetch('/api/admin/identity-sources' + (source ? '/' + encodeURIComponent(source.id) : ''), {
    method: source ? 'PUT' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ provider, tenant_id: draft.tenant.trim(), client_id: provider === 'wecom' ? draft.tenant.trim() : draft.client.trim(), agent_id: provider === 'wecom' ? draft.agent.trim() : null,
     client_secret: draft.secret || null, enabled: draft.enabled, login_enabled: draft.login, sync_enabled: draft.sync, sync_schedule: {frequency: draft.frequency, time: draft.time, timezone: draft.zone, weekday: Number(draft.weekday)} }),
   })
   if (!response.ok) throw Error(response.status === 409 ? '该企业应用已存在，请编辑已有配置。' : '保存应用配置失败，请重试。')
   onSaved()
  } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败。') }
  finally { submitting.current = false; setBusy(false) }
 }
 return <><GatewayConfirmDialog title={names[provider] + '应用配置'} message="配置企业应用并选择组织同步及扫码登录。" confirmLabel="保存配置" disabled={!valid} busy={busy} onConfirm={() => void save()} onCancel={() => dirty ? setDiscard(true) : onClose()}>
  <p><a href={provider === 'dingtalk' ? 'https://open-dev.dingtalk.com/' : 'https://work.weixin.qq.com/wework_admin/'} target="_blank" rel="noopener noreferrer">打开{names[provider]}{provider === 'dingtalk' ? '开发者' : '管理'}后台</a><br />{provider === 'dingtalk' ? '在后台查看企业 Corp ID；进入应用的「凭证与基础信息」获取 Client ID 和 Client Secret。' : '在「我的企业 → 企业信息」获取企业 Corp ID；进入「应用管理 → 自建应用」获取 Agent ID 和 Secret。'}</p>
  <div className="gateway-application-fields">
   <label>企业 Corp ID<input value={draft.tenant} disabled={busy} onChange={event => change('tenant', event.target.value)} /><small>{provider === 'dingtalk' ? '企业 ID（通常以 ding 开头），用于登录企业校验；不是应用 AgentId 或 App ID。' : '企业微信的企业 ID，用于获取企业凭证和扫码登录。'}</small></label>
   {provider === 'dingtalk' && <label>App Key / Client ID<input value={draft.client} disabled={busy} onChange={event => change('client', event.target.value)} /></label>}
   {provider === 'wecom' && <label>Agent ID<input value={draft.agent} disabled={busy} onChange={event => change('agent', event.target.value)} /></label>}
   <label>应用 Secret<input type="password" autoComplete="new-password" value={draft.secret} disabled={busy} placeholder={source ? '留空保留已保存的密钥' : '请输入应用密钥'} onChange={event => change('secret', event.target.value)} /></label>
   <label className="gateway-check-label"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => change('enabled', event.target.checked)} />启用应用</label>
   <label className="gateway-check-label"><input type="checkbox" checked={draft.sync} disabled={busy} onChange={event => change('sync', event.target.checked)} />启用组织同步</label>
   <label>自动同步频率<select value={draft.frequency} disabled={busy} onChange={event => change('frequency', event.target.value)}><option value="off">关闭</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
   {draft.frequency !== 'off' && <><label>执行时间<input type="time" value={draft.time} disabled={busy} onChange={event => change('time', event.target.value)} /></label><label>时区<input value={draft.zone} disabled={busy} onChange={event => change('zone', event.target.value)} /></label>{draft.frequency === 'weekly' && <label>星期<select value={draft.weekday} disabled={busy} onChange={event => change('weekday', event.target.value)}>{['一','二','三','四','五','六','日'].map((day,index)=><option key={index} value={index}>星期{day}</option>)}</select></label>}</>}
   <label className="gateway-check-label"><input type="checkbox" checked={draft.login} disabled={busy} onChange={event => change('login', event.target.checked)} />启用扫码登录</label>
  </div>
  {source && draft.tenant.trim() !== source.tenant_id && <p role="status">正在更正企业 Corp ID；已有用户组和成员关联会保留。请确认仍是原企业，改为另一企业应添加新应用。</p>}
  <p>自动同步需先完成一次组织选择并确认同步；之后沿用该范围。自动同步失败五分钟后重试，有变更或失败时在管理后台显示组织同步提示。</p>
  <p>密钥加密保存，保存后不再回显。请在企业应用后台授权通讯录读取权限，并配置本平台的登录回调域。</p>
  {source && <label>登录回调地址<input readOnly value={(platformAddress || window.location.origin).replace(/\/+$/, '') + '/api/auth/external/' + source.id + '/callback'} /></label>}
  {error && <p role="alert" className="gateway-auth-error">{error}</p>}
 </GatewayConfirmDialog>
 {discard && <GatewayConfirmDialog title="放弃应用配置" message="尚未保存的修改将丢失。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}</>
}

export function OrganizationSyncSettings({ csrf, platformAddress }: { csrf: string; platformAddress?: string | null }) {
 const [sources, setSources] = useState<Application[]>([])
 const [page, setPage] = useState(1); const [total, setTotal] = useState(0)
 const [revision, setRevision] = useState(0); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
 const [loading, setLoading] = useState(true)
 const [historySource,setHistorySource]=useState<string | null>(null)
 const [syncSource, setSyncSource] = useState<Application | null>(null)
 const [editor, setEditor] = useState<{ provider: Application['provider']; source?: Application } | null>(null)
 useEffect(() => {
  const controller = new AbortController(); setLoading(true); setError('')
  void fetch(`/api/admin/identity-sources?page=${page}&page_size=25`, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
   if (!response.ok) throw Error('企业应用配置加载失败。')
   const result = await response.json(); if (!controller.signal.aborted) { setSources(result.sources ?? []); setTotal(result.total ?? result.sources?.length ?? 0) }
  }).catch(() => { if (!controller.signal.aborted) setError('企业应用配置加载失败，请重试。') }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
  return () => controller.abort()
 }, [revision, page])
 return <section className="gateway-project-grants gateway-organization-settings"><div className="gateway-admin-toolbar"><h3>组织同步与扫码登录</h3>
  <div className="gateway-device-actions"><OrganizationSyncNotice/><button type="button" disabled={!csrf} onClick={() => setEditor({ provider: 'dingtalk' })}>添加钉钉应用</button><button type="button" disabled={!csrf} onClick={() => setEditor({ provider: 'wecom' })}>添加企业微信应用</button></div>
 </div><p>同步将按企业部门层级创建用户组及成员；启用扫码登录后，对应入口会出现在平台登录页。</p>
 {loading && <p role="status"><span className="gateway-spinner" /> 正在加载企业应用…</p>}
 {error && <p role="alert" className="gateway-auth-error">{error}<button type="button" onClick={() => setRevision(value => value+1)}>重试</button></p>}
 {notice && <p role="status">{notice}</p>}
 <AdminRecordTable columns={['应用', '组织同步', '扫码登录', '最近同步', '操作']}>{sources.map(source => <tr key={source.id}>
  <td><strong>{names[source.provider]}</strong><p>{source.tenant_id}</p><small>{source.secret_configured ? '密钥已配置' : '请配置密钥'}{source.enabled ? '' : ' · 应用已停用'}</small></td>
  <td>{source.sync_enabled === false ? '关闭' : '启用'}<p>自动同步：{source.sync_schedule?.frequency === 'daily' ? '每天' : source.sync_schedule?.frequency === 'weekly' ? '每周' : '关闭'}</p>{source.next_sync_at && source.sync_enabled !== false && source.enabled && <small>下次：{new Date(source.next_sync_at).toLocaleString()}</small>}</td><td>{source.login_enabled === false ? '关闭' : '启用'}</td>
  <td>{source.sync_state?.last_success_at ? new Date(source.sync_state.last_success_at).toLocaleString() : '尚未同步'}{source.sync_state?.last_error_code && <p>最近同步失败</p>}</td>
  <td><div className="gateway-device-actions"><button type="button" disabled={!csrf} onClick={() => setEditor({ provider: source.provider, source })}>编辑配置</button>
   <button type="button" disabled={!csrf || !source.enabled || source.sync_enabled === false} onClick={() => setSyncSource(source)}>同步组织与用户</button><button type="button" onClick={()=>setHistorySource(source.id)}>同步记录</button></div></td>
 </tr>)}</AdminRecordTable>
 {!loading && !sources.length && <p>尚未配置企业应用。</p>}
 {total > 25 && <div className="gateway-admin-pagination"><span>共 {total} 个应用 · 第 {page}/{Math.ceil(total/25)} 页</span><button type="button" disabled={loading || page <= 1} onClick={() => setPage(value => value-1)}>上一页</button><button type="button" disabled={loading || page*25 >= total} onClick={() => setPage(value => value+1)}>下一页</button></div>}
 {syncSource && <OrganizationSyncPanel key={syncSource.id} sourceId={syncSource.id} provider={syncSource.provider} csrf={csrf} onClose={() => setSyncSource(null)} onCompleted={() => { setNotice(names[syncSource.provider] + '组织同步完成，已更新用户组和用户。'); setRevision(value => value + 1) }} />}
 {historySource && <OrganizationSyncHistory sourceId={historySource} onClose={()=>setHistorySource(null)}/>}
 {editor && <ApplicationEditor {...editor} csrf={csrf} platformAddress={platformAddress} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setPage(1); setRevision(value => value+1) }} />}
 </section>
}
