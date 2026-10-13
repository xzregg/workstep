import { useEffect, useRef, useState } from 'react'
import { AdminRecordTable } from './AdminRecordTable'
import { AdminUsagePriceDialog } from './AdminUsagePriceDialog'
import { modelPriceFields, type ModelPrices } from './ModelPriceFields'
import { usageCount } from './usageStatistics'

type Model = { model: string; event_count: number; total_tokens: number | null;
  last_seen_at: string; prices: ModelPrices | null; version: string | null }
const columns = ['选择','模型','调用次数','总 Token','最近使用','输入','输出','缓存读取','缓存写入','操作']

export function AdminUsagePrices() {
  const [models, setModels] = useState<Model[]>([])
  const [csrf, setCsrf] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [edit, setEdit] = useState<{ models:string[]; prices?:ModelPrices } | null>(null)
  const [result, setResult] = useState('')
  const all = useRef<HTMLInputElement>(null)
  const pageSelected = models.filter(model => selected.includes(model.model)).length
  useEffect(() => { if (all.current) all.current.indeterminate = pageSelected > 0 && pageSelected < models.length },[pageSelected,models])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setModels([]); setCsrf('')
    const params = new URLSearchParams({ q:query,page:String(page),page_size:'25' })
    void Promise.all([
      fetch('/api/auth/session', { credentials:'same-origin',signal:controller.signal }),
      fetch('/api/admin/usage/model-prices?'+params, { credentials:'same-origin',signal:controller.signal }),
    ]).then(async ([session,response]) => {
      if (!session.ok || !response.ok) throw new Error(response.status === 403
        ? '当前账号没有模型价格管理权限。' : '模型价格加载失败。')
      const [identity,data] = await Promise.all([session.json(),response.json()])
      if (!controller.signal.aborted) { setCsrf(identity.csrf_token); setModels(data.models ?? []); setTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '模型价格加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  },[page,query,revision])

  return <section className="gateway-usage-prices" aria-label="模型价格设置">
    <h3>统计模型价格</h3>
    <p>列出用量记录中出现过的模型（全部时间与来源），同名模型共用默认参考价（USD／百万 Token）。已有调用费用与供应商账单优先保留，历史费用不重算。</p>
    <form className="gateway-admin-search" onSubmit={event => { event.preventDefault(); setPage(1); setQuery(search.trim()); setSelected([]) }}>
      <label htmlFor="usage-price-search">搜索模型</label><input id="usage-price-search" value={search} onChange={event => setSearch(event.target.value)}/>
      <button type="submit">搜索</button></form>
    <div className="gateway-admin-toolbar gateway-usage-price-actions"><span>已选 {selected.length} 个模型（最多 100 个，可跨页选择）</span>
      <button type="button" disabled={!csrf || !selected.length || loading} onClick={() => setEdit({ models:[...selected] })}>批量设置价格</button>
      <button type="button" disabled={!selected.length} onClick={() => setSelected([])}>清空选择</button></div>
    {result && <p role="status">{result}</p>}
    {loading && <p role="status"><span className="gateway-spinner" aria-hidden="true"/> 正在加载模型价格…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && <AdminRecordTable columns={columns.map((column,index) => index ? column :
      <input ref={all} className="gateway-table-checkbox" type="checkbox" aria-label="选择本页模型" checked={!!models.length && pageSelected === models.length}
        disabled={!models.length || (pageSelected !== models.length && new Set([...selected,...models.map(model => model.model)]).size > 100)}
        onChange={event => setSelected(current => event.target.checked ? [...new Set([...current,...models.map(model => model.model)])]
          : current.filter(value => !models.some(model => model.model === value)))}/>)}>
      {models.map(model => <tr key={model.model}>
        <td><input className="gateway-table-checkbox" type="checkbox" aria-label={`选择 ${model.model}`} checked={selected.includes(model.model)}
          disabled={selected.length >= 100 && !selected.includes(model.model)} onChange={event => setSelected(current =>
            event.target.checked ? [...current,model.model] : current.filter(value => value !== model.model))}/></td>
        <td>{model.model}</td><td>{usageCount(model.event_count)}</td><td>{usageCount(model.total_tokens)}</td>
        <td>{new Date(model.last_seen_at).toLocaleString()}</td>
        {modelPriceFields.map(([field]) => <td key={field} title={model.version ?? ''}>{model.prices?.[field] ?? '未设置'}</td>)}
        <td><button type="button" disabled={!csrf} aria-label={`设置 ${model.model} 价格`}
          onClick={() => setEdit({ models:[model.model],prices:model.prices ?? undefined })}>设置价格</button></td>
      </tr>)}
      {!models.length && <tr><td colSpan={columns.length}>暂无统计到的模型。</td></tr>}
    </AdminRecordTable>}
    <div className="gateway-admin-pagination"><span>共 {total} 个模型 · 第 {page}/{Math.max(1,Math.ceil(total/25))} 页</span>
      <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" disabled={page >= Math.ceil(total/25) || loading} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    {edit && csrf && <AdminUsagePriceDialog models={edit.models} initialPrices={edit.prices} csrf={csrf}
      onClose={() => setEdit(null)} onSaved={count => { setEdit(null); setSelected([]); setResult(`已更新 ${count} 个模型价格。`); setRevision(value => value + 1) }}/>}
  </section>
}
