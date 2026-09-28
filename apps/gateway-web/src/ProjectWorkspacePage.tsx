import { useEffect, useState } from 'react'

type RemoteSession = {
  project_id: string | null
  host_project_id: string | null
  access_level: 'read' | 'edit' | null
  gateway_url: string
}
type ProjectSummary = { id: string; name: string; workflows: { id: string; name: string }[] }
type Task = { id: string; title: string; status: string }

export function ProjectWorkspacePage() {
  const [session, setSession] = useState<RemoteSession | null>(null)
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      const sessionResponse = await fetch('/api/remote/session', { signal: controller.signal })
      if (!sessionResponse.ok) throw new Error('项目会话已失效，请从平台重新打开。')
      const current: RemoteSession = await sessionResponse.json()
      if (!current.project_id || !current.host_project_id) throw new Error('这不是项目访问会话。')
      const projectId = encodeURIComponent(current.host_project_id)
      const [summaryResponse, tasksResponse] = await Promise.all([
        fetch(`/api/project/${projectId}/summary`, { signal: controller.signal }),
        fetch(`/api/task/list?project_id=${projectId}`, { signal: controller.signal }),
      ])
      if (!summaryResponse.ok || !tasksResponse.ok) throw new Error('项目数据不可用，请从平台重新打开。')
      const project: ProjectSummary = await summaryResponse.json()
      const listing: { tasks: Task[] } = await tasksResponse.json()
      if (controller.signal.aborted) return
      setSession(current)
      setSummary(project)
      setTasks(listing.tasks ?? [])
    }
    void load().catch(reason => { if (reason?.name !== 'AbortError') setError(reason.message) })
    return () => controller.abort()
  }, [])

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP REMOTE PROJECT</span>
    <h2>{summary?.name ?? '远程项目'}</h2>
    {!summary && !error && <p role="status">正在加载项目…</p>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    {summary && <>
      <p>{session?.access_level === 'edit' ? '可编辑项目' : '只读项目'} · {summary.workflows?.length ?? 0} 个流程</p>
      <h3>任务</h3>
      {tasks.length === 0 && <p>暂无任务。</p>}
      <ul className="gateway-device-list">{tasks.map(task => <li key={task.id}>
        <strong>{task.title}</strong><span>{task.status}</span>
      </li>)}</ul>
    </>}
    {session?.gateway_url && <a href={session.gateway_url.replace(/\/devices$/, '/')}>返回平台</a>}
  </section>
}
