import { useState, useEffect } from 'react'
import { useProjectStore } from '../stores/projectStore'
import { useNavigate } from 'react-router-dom'

export default function ProjectList() {
  const { projects, loading, fetchProjects, initProject, setActiveProject } = useProjectStore()
  const navigate = useNavigate()
  const [newPath, setNewPath] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  const handleInit = async () => {
    if (!newPath.trim()) return
    try {
      setError('')
      const proj = await initProject(newPath.trim(), newName.trim() || undefined)
      setActiveProject(proj)
      navigate(`/tasks`)
      setNewPath('')
      setNewName('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleSelect = (proj: typeof projects[0]) => {
    setActiveProject(proj)
    navigate('/tasks')
  }

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', padding: 20 }}>
      <h1>WorkStep</h1>
      <h2>项目列表</h2>

      {loading && <p>加载中...</p>}

      {projects.length === 0 && !loading && (
        <p style={{ color: '#888' }}>还没有项目，请初始化一个。</p>
      )}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {projects.map((p) => (
          <li
            key={p.path}
            onClick={() => handleSelect(p)}
            style={{
              padding: '12px 16px',
              margin: '8px 0',
              background: '#f5f5f5',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            <strong>{p.name}</strong>
            <br />
            <small style={{ color: '#888' }}>{p.path}</small>
          </li>
        ))}
      </ul>

      <hr style={{ margin: '24px 0' }} />
      <h3>初始化新项目</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          placeholder="项目路径（如 /Users/me/my-app）"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          style={{ padding: 8, fontSize: 14 }}
        />
        <input
          placeholder="项目名称（可选，默认目录名）"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ padding: 8, fontSize: 14 }}
        />
        <button onClick={handleInit} style={{ padding: '8px 16px', fontSize: 14 }}>
          初始化
        </button>
        {error && <p style={{ color: 'red' }}>{error}</p>}
      </div>
    </div>
  )
}
