import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTaskStore } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'

export default function TaskList() {
  const { tasks, loading, fetchTasks, createTask, setActiveTask } = useTaskStore()
  const activeProject = useProjectStore((s) => s.activeProject)
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const handleCreate = async () => {
    if (!title.trim() || !activeProject) return
    try {
      setError('')
      await createTask(title.trim(), activeProject.path)
      setTitle('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleSelect = (taskId: string) => {
    setActiveTask(taskId)
    navigate(`/tasks/${taskId}`)
  }

  const statusColor: Record<string, string> = {
    ready: '#4caf50',
    running: '#2196f3',
    stopped: '#f44336',
    paused: '#ff9800',
  }

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>
          {activeProject ? activeProject.name : '项目'}
          <small style={{ color: '#888', fontWeight: 'normal', marginLeft: 8 }}>
            任务列表
          </small>
        </h1>
        <button onClick={() => navigate('/')} style={{ padding: '4px 12px' }}>
          ← 项目
        </button>
      </div>

      {loading && <p>加载中...</p>}

      {tasks.length === 0 && !loading && (
        <p style={{ color: '#888' }}>还没有任务，创建一个。</p>
      )}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tasks.map((t) => (
          <li
            key={t.id}
            onClick={() => handleSelect(t.id)}
            style={{
              padding: '12px 16px',
              margin: '8px 0',
              background: '#f5f5f5',
              borderRadius: 8,
              cursor: 'pointer',
              borderLeft: `4px solid ${statusColor[t.status] || '#ccc'}`,
            }}
          >
            <strong>{t.title}</strong>
            <span style={{ marginLeft: 8, fontSize: 12, color: statusColor[t.status] }}>
              {t.status}
            </span>
            <br />
            <small style={{ color: '#888' }}>
              {t.engine} · {new Date(t.created_at * 1000).toLocaleString()}
            </small>
          </li>
        ))}
      </ul>

      <hr style={{ margin: '24px 0' }} />
      <h3>创建新任务</h3>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          placeholder="任务标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          style={{ flex: 1, padding: 8, fontSize: 14 }}
        />
        <button onClick={handleCreate} style={{ padding: '8px 16px', fontSize: 14 }}>
          创建
        </button>
      </div>
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  )
}
