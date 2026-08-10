import Icon from './components/Icon'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { useProjectStore } from './stores/projectStore'
import Layout from './components/Layout'
import TaskList from './pages/TaskList'
import CanvasEditor from './pages/CanvasEditor'
import type { Project } from './api/client'
import { useI18n } from './i18n'

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
  const { t } = useI18n()
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      color: 'var(--meta)', gap: 12,
    }}>
      <Icon name="layers" size={48} strokeWidth={1.5} />
      <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--fg-2)' }}>{t('welcome.title')}</div>
      <div style={{ fontSize: 13 }}>{t('welcome.subtitle')}</div>
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
