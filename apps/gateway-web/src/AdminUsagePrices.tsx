import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminRecordTable } from './AdminRecordTable'
import { AdminProviderEditorDialog, type ManagedProvider } from './AdminProviderEditorDialog'

const columns = ['供应商', '模型', '输入', '输出', '缓存读取', '缓存写入', '价格版本', '操作']
const fields = ['input_per_million', 'output_per_million', 'cache_read_per_million', 'cache_write_per_million']

export function AdminUsagePrices() {
  const [providers, setProviders] = useState<ManagedProvider[]>([])
  const [csrf, setCsrf] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<{ provider: ManagedProvider; model: string } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setProviders([]); setCsrf('')
    const params = new URLSearchParams({ q: query, page: String(page), page_size: '25', sort: 'name', direction: 'asc' })
    void Promise.all([
      fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal }),
      fetch('/api/admin/providers?' + params, { credentials: 'same-origin', signal: controller.signal }),
    ]).then(async ([session, response]) => {
      if (!session.ok || !response.ok) throw new Error(response.status === 403
        ? '当前账号没有模型价格管理权限。' : '模型价格加载失败。')
      const [identity, data] = await Promise.all([session.json(), response.json()])
      if (!controller.signal.aborted) {
        setCsrf(identity.csrf_token); setProviders(data.providers ?? []); setTotal(data.total ?? 0)
      }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '模型价格加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [page, query, revision])

  return <section className="gateway-usage-prices" aria-label="模型价格设置">
    <div className="gateway-admin-toolbar"><h3>模型价格</h3><Link to="/admin/providers">管理供应商和模型</Link></div>
    <p>按供应商分别设置每百万 Token 单价（USD）。留空为未设置，0 表示免费；新价格应用到设备后用于后续调用估算，历史费用保留原快照。</p>
    <form className="gateway-admin-search" onSubmit={event => { event.preventDefault(); setPage(1); setQuery(search.trim()) }}>
      <label htmlFor="usage-price-search">搜索供应商</label><input id="usage-price-search" value={search} onChange={event => setSearch(event.target.value)}/>
      <button type="submit">搜索</button>
    </form>
    {loading && <p role="status"><span className="gateway-spinner" aria-hidden="true"/> 正在加载模型价格…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && <AdminRecordTable columns={columns}>
      {providers.flatMap(provider => provider.models.map(model => <tr key={provider.id+':'+model}>
        <td>{provider.name}{!provider.enabled && <small> · 已停用</small>}</td><td>{model}</td>
        {fields.map(field => <td key={field}>{provider.prices.models?.[model]?.[field] ?? '未设置'}</td>)}
        <td>{provider.prices.version ?? '未设置'}</td>
        <td><button type="button" disabled={!csrf} aria-label={`设置 ${provider.name} ${model} 价格`}
          onClick={() => setEdit({ provider, model })}>设置价格</button></td>
      </tr>))}
      {!providers.some(provider => provider.models.length) && <tr><td colSpan={columns.length}>没有已配置的模型，请先在供应商管理中添加模型。</td></tr>}
    </AdminRecordTable>}
    <div className="gateway-admin-pagination"><span>共 {total} 个供应商 · 第 {page}/{Math.max(1, Math.ceil(total / 25))} 页</span>
      <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" disabled={page >= Math.ceil(total / 25) || loading} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    {edit && csrf && <AdminProviderEditorDialog key={edit.provider.id+':'+edit.model} provider={edit.provider}
      priceModel={edit.model} csrf={csrf} onClose={() => setEdit(null)}
      onSaved={() => { setEdit(null); setRevision(value => value + 1) }}/>} 
  </section>
}
