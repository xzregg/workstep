import { useEffect, useState } from 'react'

type Grant = {
  subject_type: 'user' | 'group'
  subject_id: string
  subject_name: string
  access_level: 'read' | 'edit'
}

function ProjectGrants({ canManage, gatewayUrl }: { canManage: boolean; gatewayUrl: string }) {
  const [grants, setGrants] = useState<Grant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    void fetch('/api/remote/project-grants', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Project grants unavailable')
        if (!controller.signal.aborted) setGrants((await response.json()).grants ?? [])
      }).catch(() => { if (!controller.signal.aborted) setError(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])

  return <div>
    {loading ? <p role="status">正在加载访问授权…</p> : error ?
      <div role="alert"><p>读取访问授权失败。</p>
        <button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div> :
      grants.length === 0 ? <p>暂无访问授权。</p> :
      <ul className="gateway-project-access-list">{grants.map(grant =>
        <li key={`${grant.subject_type}:${grant.subject_id}`}>{
          grant.subject_type === 'user' ? '用户' : '用户组'} · {grant.subject_name} · {
          grant.access_level === 'edit' ? '可编辑' : '只读'}</li>)}</ul>}
    {canManage && <a href={`${gatewayUrl.replace(/\/devices$/, '')}/admin/projects`}>管理授权</a>}
  </div>
}

export function ProjectAccessSettings({ projectName, accessLevel, canManage, gatewayUrl }: {
  projectName: string
  accessLevel: 'read' | 'edit'
  canManage: boolean
  gatewayUrl: string
}) {
  const [tab, setTab] = useState<'overview' | 'access'>('overview')
  return <section className="gateway-project-settings" aria-label="项目设置">
    <div className="gateway-project-settings-tabs" role="tablist" aria-label="项目设置">
      <button type="button" role="tab" aria-selected={tab === 'overview'}
        onClick={() => setTab('overview')}>概览</button>
      <button type="button" role="tab" aria-selected={tab === 'access'}
        onClick={() => setTab('access')}>访问授权</button>
    </div>
    <div role="tabpanel">
      {tab === 'overview' ? <p>{projectName} · {accessLevel === 'edit' ? '可编辑' : '只读'}</p> :
        <ProjectGrants canManage={canManage} gatewayUrl={gatewayUrl} />}
    </div>
  </section>
}
