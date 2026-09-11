import { BrandIcon } from './components/BrandIcon'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { useProjectStore } from './stores/projectStore'
import Layout from './components/Layout'
import TaskList from './pages/TaskList'
import CanvasEditor from './pages/CanvasEditor'
import StatisticsPage from './pages/StatisticsPage'
import SchedulePage from './pages/SchedulePage'
import ChatPage from './pages/ChatPage'
import ChannelsPage from './pages/ChannelsPage'
import SharedTaskView from './pages/SharedTaskView'
import type { Project } from './api/client'
import { useI18n } from './i18n'
import FirstUseDialog from './components/FirstUseDialog'
import { projectSelectionPath } from './utils/projectSelectionPath'

function AppRoutes() {
  const navigate = useNavigate()
  const location = useLocation()
  const { activeProject } = useProjectStore()

  const handleSelectProject = (project: Project) => {
    // Always carry the clicked project in the URL. A bare `/tasks` lets the
    // still-mounted route hook read the previous location (e.g.
    // `/chat?project=workstep`) and write the old project back into the store,
    // after which the bare task list is canonicalized to that stale project.
    navigate(
      projectSelectionPath(
        location.pathname,
        project.name,
        useProjectStore.getState().activeWorkflowId,
      ),
    )
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
        <Route path="/channels" element={activeProject ? <ChannelsPage /> : <WelcomeView />} />
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
      <BrandIcon size={48} />
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
