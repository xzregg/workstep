import { AdminRecordDetails } from './AdminRecordDetails'
import { AdminListStatus } from './AdminListStatus'
import { GatewayDateRange } from './GatewayDateRange'
import { AdminRecordTable } from './AdminRecordTable'
import { useEffect, useState } from 'react'
import { LedgerExportButton } from './LedgerExportButton'

type AuditEvent = {
  id: string; occurred_at: string; action: string; result: string
  actor_id: string | null; actor_username: string | null; actor_name: string | null
  actor_type: string | null; actor_device_id: string | null; actor_device_name: string | null
  device_id: string | null; mode: string | null
  initiated_by_user_id: string | null; initiated_by_username: string | null
  project_id: string | null; platform_project_id: string | null; project_name: string | null
  task_id: string | null; metadata: Record<string, string | number | boolean>
}
type Filters = { device_id: string; from_time: string; to_time: string; user_id: string; project_id: string;
  action: string; result: string; q: string }
const emptyFilters: Filters = { device_id: '', from_time: '', to_time: '', user_id: '', project_id: '',
  action: '', result: '', q: '' }
const pageSize = 25
const loginMethods: Record<string, string> = { password: '账号密码', dingtalk: '钉钉', wecom: '企业微信', scan: '企业扫码（历史会话）', unknown: '未知' }
const loginActions: Record<string, string> = { 'auth.login': '平台登录', 'auth.device.login': '进入设备工作台', 'auth.desktop.login': '设备授权登录', 'auth.identity.bind': '绑定企业身份' }
const auditResults: Record<string, string> = { success: '成功', succeeded: '成功', denied: '拒绝', failed: '失败' }
const value = (item: string | null | undefined) => item || '未知'

export function AdminAuditPage() {
  const [draft, setDraft] = useState<Filters>(emptyFilters)
  const [filters, setFilters] = useState('')
  const [page, setPage] = useState(1)
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [validation, setValidation] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams(filters)
    params.set('limit', String(pageSize))
    params.set('offset', String((page - 1) * pageSize))
    setLoading(true); setError('')
    void fetch(`/api/admin/audit?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('审计记录加载失败。')
        const data = await response.json()
        if (!controller.signal.aborted) { setEvents(data.items ?? []); setTotal(data.total ?? 0) }
      }).catch(reason => {
        if (!controller.signal.aborted && reason?.name !== 'AbortError') {
          setError(reason instanceof Error ? reason.message : '审计记录加载失败。')
        }
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [filters, page, revision])

  function apply() {
    const from = draft.from_time ? new Date(draft.from_time) : null
    const to = draft.to_time ? new Date(draft.to_time) : null
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))
        || (from && to && from >= to)) {
      setValidation('结束时间必须晚于开始时间。'); return
    }
    setValidation('')
    const params = new URLSearchParams()
    for (const [field, raw] of Object.entries(draft)) {
      const item = raw.trim()
      if (item) params.set(field, field === 'from_time' ? from!.toISOString()
        : field === 'to_time' ? to!.toISOString() : item)
    }
    setPage(1); setFilters(params.toString())
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台 · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>审计记录</h2></div>
    <p>区分平台登录、桌面设备授权和进入设备工作台；待设备审批不代表已成功登录设备。失败时的尝试账号不代表已验证身份。历史事件不会补录。</p>
    <form className="gateway-usage-filters" onSubmit={event => { event.preventDefault(); apply() }}>
      <GatewayDateRange from={draft.from_time} to={draft.to_time}
        onChange={range => setDraft(current => ({ ...current, ...range }))} />
      <label>用户 ID<input value={draft.user_id} maxLength={64}
        onChange={event => setDraft(current => ({ ...current, user_id: event.target.value }))} /></label>
      <label>设备 ID<input value={draft.device_id} maxLength={64}
        onChange={event => setDraft(current => ({ ...current, device_id: event.target.value }))} /></label>
      <label>平台项目 ID<input value={draft.project_id} maxLength={64}
        onChange={event => setDraft(current => ({ ...current, project_id: event.target.value }))} /></label>
      <label>操作类型<input value={draft.action} maxLength={128}
        onChange={event => setDraft(current => ({ ...current, action: event.target.value }))} /></label>
      <label>结果<select value={draft.result}
        onChange={event => setDraft(current => ({ ...current, result: event.target.value }))}>
        <option value="">全部</option><option value="success">成功（Gateway）</option>
        <option value="succeeded">成功（PC）</option><option value="denied">拒绝</option>
        <option value="failed">失败</option></select></label>
      <label>关键词<input value={draft.q} maxLength={128}
        onChange={event => setDraft(current => ({ ...current, q: event.target.value }))} /></label>
      <div className="gateway-usage-filter-actions"><button type="submit">查询审计</button>
        <button type="button" onClick={() => {
          setDraft(emptyFilters); setPage(1); setFilters(''); setValidation('')
        }}>清除筛选</button></div>
    </form>
    {validation && <p role="alert" className="gateway-auth-error">{validation}</p>}
    <AdminListStatus loading={loading} label="正在加载审计记录…"/>
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(current => current + 1)}>重试</button></p>}
    {!loading && !error && events.length === 0 && <p>当前条件下没有审计记录。</p>}
    <AdminRecordTable busy={loading} columns={['发生时间','操作','操作人','登录方式','设备','项目','结果','目标','操作']}>
      {events.map(item => <tr key={item.id}>
        <td>{new Date(item.occurred_at).toLocaleString()}</td><td title={item.action}>{loginActions[item.action] || item.action}</td>
        <td title={item.actor_id || ''}>{item.actor_type === 'anonymous' ? `未认证${item.actor_username ? `（尝试账号：${item.actor_username}）` : ''}` : value(item.actor_name || item.actor_username || item.actor_id)}</td>
        <td>{item.metadata.login_method ? loginMethods[String(item.metadata.login_method)] || '未知' : '—'}</td>
        <td title={item.device_id || ''}>{value(item.metadata.device_name?.toString() || item.device_id)}</td><td>{value(item.project_name || item.platform_project_id)}</td>
        <td>{item.metadata.reason_code === 'device_pending' ? '待设备审批' : auditResults[item.result] || item.result}</td><td title={item.task_id || item.platform_project_id || ''}>{value(item.task_id || item.metadata.subject_id?.toString() || item.platform_project_id)}</td>
        <td><AdminRecordDetails label="审计详情" title={`审计详情 ${item.id}`}>
          <p>事件 {item.id} · 操作人 {value(item.actor_id)} · 类型 {value(item.actor_type)} · 模式 {value(item.mode)}</p>
          <p>操作设备 {value(item.actor_device_name || item.actor_device_id)} · 宿主 PC {value(item.device_id)}</p>
          <p>原始发起人 {value(item.initiated_by_username || item.initiated_by_user_id)}</p>
          <p>平台项目 {value(item.platform_project_id)} · 宿主项目 {value(item.project_id)} · 任务 {value(item.task_id)}</p>
          <p>流程运行 {value(item.metadata.workflow_run_id?.toString())} · 审核运行 {value(item.metadata.review_run_id?.toString())} · 阶段 {value(item.metadata.step_key?.toString())}</p>
          <dl className="gateway-admin-details">{Object.entries(item.metadata).map(([key,data]) => <div key={key}><dt>{key}</dt><dd>{String(data)}</dd></div>)}</dl>
        </AdminRecordDetails></td>
      </tr>)}
    </AdminRecordTable>
    <div className="gateway-admin-pagination"><span>共 {total} 条记录 · 第 {page}/{
      Math.max(1, Math.ceil(total / pageSize))} 页</span>
      <LedgerExportButton rows={events} filename={`audit-page-${page}.csv`} disabled={loading || !!error}
        columns={[{ name: '事件 ID', key: 'id' }, { name: '时间', key: 'occurred_at' },
          { name: '操作', key: 'action' }, { name: '结果', key: 'result' },
          { name: '用户 ID', key: 'actor_id' }, { name: '用户名', key: 'actor_username' }, { name: '姓名', key: 'actor_name' }, { name: '设备 ID', key: 'device_id' },
          { name: '项目 ID', key: 'platform_project_id' }, { name: '任务 ID', key: 'task_id' },
          { name: '详情', key: 'metadata' }]} />
      <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(current => current - 1)}>上一页</button>
      <button type="button" disabled={page >= Math.ceil(total / pageSize) || loading}
        onClick={() => setPage(current => current + 1)}>下一页</button></div>
  </section>
}
