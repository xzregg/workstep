import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { useProjectStore } from './stores/projectStore'
import Layout from './components/Layout'
import TaskList from './pages/TaskList'
import CanvasEditor from './pages/CanvasEditor'
import type { Project } from './api/client'

function AppRoutes() {
  const navigate = useNavigate()
  const location = useLocation()
  const { activeProject } = useProjectStore()

  const handleSelectProject = (project: Project) => {
    if (location.pathname === '/canvas') {
      navigate(`/canvas?project=${encodeURIComponent(project.name)}`)
      return
    }
    navigate('/tasks')
  }

  return (
    <Layout onSelectProject={handleSelectProject}>
      <Routes>
        <Route path="/" element={<WelcomeView />} />
        <Route path="/tasks" element={activeProject ? <TaskList /> : <WelcomeView />} />
        <Route path="/canvas" element={<CanvasEditor />} />
        <Route path="*" element={<WelcomeView />} />
      </Routes>
    </Layout>
  )
}

function WelcomeView() {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      color: 'var(--meta)', gap: 12,
    }}>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
      <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--fg-2)' }}>WorkStep</div>
      <div style={{ fontSize: 13 }}>选择或创建一个项目开始</div>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}

export default App
