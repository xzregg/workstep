import Icon from './components/Icon'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { useProjectStore } from './stores/projectStore'
import Layout from './components/Layout'
import TaskList from './pages/TaskList'
import CanvasEditor from './pages/CanvasEditor'
import StatisticsPage from './pages/StatisticsPage'
import SchedulePage from './pages/SchedulePage'
import ChatPage from './pages/ChatPage'
import SharedTaskView from './pages/SharedTaskView'
import type { Project } from './api/client'
import { useI18n } from './i18n'
import FirstUseDialog from './components/FirstUseDialog'

function AppRoutes() {
  const navigate = useNavigate()
  const location = useLocation()
  const { activeProject } = useProjectStore()

  const handleSelectProject = (project: Project) => {
    if (location.pathname === '/canvas') {
      navigate(`/canvas?project=${encodeURIComponent(project.name)}`)
      return
    }
    if (location.pathname === '/schedules') {
      navigate('/schedules')
      return
    }
    navigate('/tasks')
  }

  // The share viewer is a standalone read-only page with its own chrome;
  // render it without the regular Layout sidebar/header.
  if (location.pathname.startsWith('/share/')) {
    return (
      <Routes>
        <Route path="/share/:token" element={<SharedTaskView />} />
      </Routes>
    )
  }

  return (
    <Layout onSelectProject={handleSelectProject}>
      <Routes>
        <Route path="/" element={<WelcomeView />} />
        <Route path="/tasks" element={activeProject ? <TaskList /> : <WelcomeView />} />
        <Route path="/canvas" element={<CanvasEditor />} />
        <Route path="/statistics" element={<StatisticsPage />} />
        <Route path="/schedules" element={activeProject ? <SchedulePage /> : <WelcomeView />} />
        <Route path="/chat" element={activeProject ? <ChatPage /> : <WelcomeView />} />
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
      <div style={{ fontSize: 'calc(16px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)' }}>{t('welcome.title')}</div>
      <div style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('welcome.subtitle')}</div>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
      <FirstUseDialog />
    </BrowserRouter>
  )
}

export default App
