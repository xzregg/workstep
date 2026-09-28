import { useEffect, useState } from 'react'

type RemoteSession = {
  project_id: string | null
  host_project_id: string | null
  access_level: 'read' | 'edit' | null
  task_create: boolean
  gateway_url: string
}
type ProjectSummary = {
  id: string
  name: string
  workflows: { id: string; name: string; is_default?: boolean; deleted?: boolean }[]
}
type Task = { id: string; title: string; status: string; description?: string | null }

export function ProjectWorkspacePage() {
  const [session, setSession] = useState<RemoteSession | null>(null)
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [taskLoading, setTaskLoading] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [workflowId, setWorkflowId] = useState('')
  const [saving, setSaving] = useState(false)
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
      const available = project.workflows?.filter(workflow => !workflow.deleted) ?? []
      setWorkflowId((available.find(workflow => workflow.is_default) ?? available[0])?.id ?? '')
    }
    void load().catch(reason => { if (reason?.name !== 'AbortError') setError(reason.message) })
    return () => controller.abort()
  }, [])

  async function openTask(taskId: string) {
    if (!session?.host_project_id) return
    setTaskLoading(true); setError('')
    try {
      const response = await fetch(
        `/api/task/${encodeURIComponent(taskId)}?project_id=${encodeURIComponent(session.host_project_id)}`,
      )
      if (!response.ok) throw new Error('任务详情不可用。')
      setSelectedTask(await response.json())
    } catch (reason) { setError(reason instanceof Error ? reason.message : '任务详情不可用。') }
    finally { setTaskLoading(false) }
  }

  async function createTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session?.host_project_id || !newTitle.trim() || !workflowId) return
    setSaving(true); setError('')
    try {
      const response = await fetch(
        `/api/task/create?project_id=${encodeURIComponent(session.host_project_id)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle.trim(), workflow_id: workflowId, auto_start: false }),
        },
      )
      if (!response.ok) throw new Error('创建任务失败，请检查项目授权和流程。')
      const created: Task = await response.json()
      setTasks(current => [created, ...current])
      setSelectedTask(created)
      setNewTitle('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '创建任务失败。') }
    finally { setSaving(false) }
  }

  async function startTask(taskId: string) {
    if (!session?.host_project_id) return
    setSaving(true); setError('')
    try {
      const response = await fetch(
        `/api/task/run?project_id=${encodeURIComponent(session.host_project_id)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: taskId, prompt: '' }),
        },
      )
      if (!response.ok) throw new Error('启动任务失败。')
      setSelectedTask(current => current?.id === taskId ? { ...current, status: 'running' } : current)
      setTasks(current => current.map(task => task.id === taskId ? { ...task, status: 'running' } : task))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '启动任务失败。') }
    finally { setSaving(false) }
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP REMOTE PROJECT</span>
    <h2>{summary?.name ?? '远程项目'}</h2>
    {!summary && !error && <p role="status">正在加载项目…</p>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    {summary && <>
      <p>{session?.access_level === 'edit' ? '编辑授权' : '只读授权'} · {summary.workflows?.length ?? 0} 个流程</p>
      {session?.access_level === 'edit' && session.task_create && <form
        className="gateway-project-create" onSubmit={event => void createTask(event)}>
        <h3>新建任务</h3>
        <label htmlFor="gateway-task-title">任务标题</label>
        <input id="gateway-task-title" value={newTitle}
               onChange={event => setNewTitle(event.target.value)} />
        <label htmlFor="gateway-task-workflow">流程</label>
        <select id="gateway-task-workflow" value={workflowId}
                onChange={event => setWorkflowId(event.target.value)}>
          {(summary.workflows ?? []).filter(workflow => !workflow.deleted).map(workflow =>
            <option key={workflow.id} value={workflow.id}>{workflow.name}</option>) }
        </select>
        <button type="submit" disabled={saving || !newTitle.trim() || !workflowId}>
          {saving ? '正在创建…' : '创建任务'}
        </button>
      </form>}
      <h3>任务</h3>
      {tasks.length === 0 && <p>暂无任务。</p>}
      <ul className="gateway-device-list">{tasks.map(task => <li key={task.id}>
        <div><strong>{task.title}</strong><p>{task.status}</p></div>
        <button type="button" disabled={taskLoading} onClick={() => void openTask(task.id)}>
          查看任务
        </button>
      </li>)}</ul>
      {selectedTask && <section className="gateway-project-task-detail">
        <h3>{selectedTask.title}</h3>
        <p>{selectedTask.status}</p>
        {selectedTask.description && <p>{selectedTask.description}</p>}
        {session?.access_level === 'edit' && selectedTask.status === 'ready' && <button
          type="button" disabled={saving} onClick={() => void startTask(selectedTask.id)}>
          {saving ? '正在启动…' : '启动任务'}
        </button>}
        <button type="button" onClick={() => setSelectedTask(null)}>关闭详情</button>
      </section>}
    </>}
    {session?.gateway_url && <a href={session.gateway_url.replace(/\/devices$/, '/')}>返回平台</a>}
  </section>
}
