import { gatewayWorkspacePath } from './utils/gatewayWorkspacePath'
import { BrandIcon } from './components/BrandIcon'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useProjectStore } from './stores/projectStore'
import Layout from './components/Layout'
import TaskList from './pages/TaskList'
import CanvasEditor from './pages/CanvasEditor'
import StatisticsPage from './pages/StatisticsPage'
import SchedulePage from './pages/SchedulePage'
import ChatPage from './pages/ChatPage'
import GitWorkspace from './pages/GitWorkspace'
import SharedTaskView from './pages/SharedTaskView'
import { gatewayShareApi, isGatewayPublicShare } from './api/gatewayShare'
import FilePreviewPage from './pages/FilePreviewPage'
import type { Project } from './api/client'
import { useI18n } from './i18n'
import FirstUseDialog from './components/FirstUseDialog'
import RemoteAccessGate from './components/RemoteAccessGate'
import GatewayRemoteFrame from './components/GatewayRemoteFrame'
import { projectSelectionPath } from './utils/projectSelectionPath'
import { isGatewayRemoteBrowser } from './utils/gatewayRemote'
import { useGatewaySessionStore } from './stores/gatewaySessionStore'

const GitPrototype = import.meta.env?.DEV
  ? lazy(() => import('./pages/prototype/GitPrototype'))
  : null

export function AppRoutes() {
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
      { state: { preserveNavigationDrawer: true } },
    )
  }

  // The share viewer is a standalone read-only page with its own chrome;
  // render it without the regular Layout sidebar/header.
  if (location.pathname.startsWith('/share/')) {
    return (
      <Routes>
        <Route path="/share/:token" element={<SharedTaskView api={isGatewayPublicShare() ? gatewayShareApi : undefined} />} />
      </Routes>
    )
  }

  if (location.pathname === '/file-preview') {
    return (
      <Routes>
        <Route path="/file-preview" element={<FilePreviewPage />} />
      </Routes>
    )
  }

  return (
    <Layout onSelectProject={handleSelectProject}>
      <Routes>
        <Route path="/" element={activeProject && useGatewaySessionStore.getState().session?.host_project_id
          ? <Navigate replace to={projectSelectionPath('/tasks', activeProject.name, useProjectStore.getState().activeWorkflowId)} />
          : <WelcomeView />} />
        <Route path="/git" element={<GitWorkspace />} />
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
      <BrandIcon size={48} />
      <div style={{ fontSize: 'calc(16px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)' }}>{t('welcome.title')}</div>
      <div style={{ fontSize: 'calc(13px * var(--font-scale))' }}>{t('welcome.subtitle')}</div>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter basename={gatewayWorkspacePath() || undefined}>
      <GatewayRemoteFrame><GatedApp /></GatewayRemoteFrame>
    </BrowserRouter>
  )
}

function GatedApp() {
  const location = useLocation()
  if (isGatewayRemoteBrowser()) return <AppRoutes />
  // Development-only mock surface: no daemon, project selection or Git operations.
  if (GitPrototype && location.pathname === '/prototype/git') {
    return <Suspense fallback={<div>…</div>}><GitPrototype /></Suspense>
  }
  // Public share pages authenticate with their own session token and must
  // stay reachable even when the remote access password is enabled.
  const bypassGate =
    location.pathname.startsWith('/share/') ||
    location.pathname === '/file-preview'

  if (bypassGate) {
    if (isGatewayPublicShare()) return <AppRoutes />
    return (
      <>
        <AppRoutes />
        <FirstUseDialog />
      </>
    )
  }

  return (
    <RemoteAccessGate>
      <AppRoutes />
      <FirstUseDialog />
    </RemoteAccessGate>
  )
}

export default App
