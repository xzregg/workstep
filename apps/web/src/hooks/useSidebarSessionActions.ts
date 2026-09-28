import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { chatSessionApi, type Project } from '../api/client'
import { useI18n } from '../i18n'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import { useProjectStore } from '../stores/projectStore'

/** Owns sidebar conversation mutations and the navigation that follows removal. */
export function useSidebarSessionActions() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const projects = useProjectStore((state) => state.projects)
  const activeProject = useProjectStore((state) => state.activeProject)
  const activeSessionId = location.pathname === '/chat'
    ? new URLSearchParams(location.search).get('session')
    : null
  const [creatingSession, setCreatingSession] = useState(false)
  const creatingRef = useRef(false)
  const [sessionError, setSessionError] = useState('')

  useEffect(() => {
    if (!sessionError) return
    const timer = window.setTimeout(() => setSessionError(''), 5000)
    return () => window.clearTimeout(timer)
  }, [sessionError])

  const createSession = async (project: Project) => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreatingSession(true)
    setSessionError('')
    try {
      const detail = await chatSessionApi.create({ project_id: project.id })
      useChatListStore.getState().addSession({
        id: detail.id,
        project_id: detail.project_id,
        workflow_id: detail.workflow_id,
        title: detail.title,
        engine: detail.engine,
        model: detail.model,
        message_count: detail.message_count,
        created_at: detail.created_at,
        updated_at: detail.updated_at,
      })
      navigate(`/chat?project=${encodeURIComponent(project.name)}&session=${encodeURIComponent(detail.id)}`)
    } catch (reason) {
      setSessionError(
        reason instanceof Error && reason.name === 'TimeoutError'
          ? t('chatSession.createTimeout')
          : reason instanceof Error ? reason.message : t('chatSession.createFailed'),
      )
    } finally {
      creatingRef.current = false
      setCreatingSession(false)
    }
  }

  const renameSession = async (sessionId: string, projectId: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      const updated = await chatSessionApi.rename(sessionId, projectId, trimmed)
      useChatListStore.getState().renameSession(sessionId, updated.title)
    } catch {
      // Keep the old title on failure.
    }
  }

  const deleteSession = async (sessionId: string, projectId: string): Promise<boolean> => {
    setSessionError('')
    try {
      await chatSessionApi.remove(sessionId, projectId)
      useChatListStore.getState().removeSession(sessionId)
      useChatSessionStore.getState().resetSession(sessionId)
      if (activeSessionId === sessionId) {
        const next = useChatListStore.getState().sessionsByProject[projectId]?.[0]
        const ownerName = projects.find((project) => project.id === projectId)?.name || activeProject?.name || ''
        navigate(`/chat?project=${encodeURIComponent(ownerName)}${next ? `&session=${encodeURIComponent(next.id)}` : ''}`, {
          replace: true,
          state: { preserveNavigationDrawer: true },
        })
      }
      return true
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : t('chatSession.deleteFailed'))
      return false
    }
  }

  const archiveSession = async (sessionId: string, projectId: string) => {
    setSessionError('')
    try {
      await chatSessionApi.setArchived(sessionId, projectId, true)
      useChatListStore.getState().removeSession(sessionId)
      if (activeSessionId === sessionId) {
        const next = useChatListStore.getState().sessionsByProject[projectId]?.[0]
        const ownerName = projects.find((project) => project.id === projectId)?.name || activeProject?.name || ''
        navigate(`/chat?project=${encodeURIComponent(ownerName)}${next ? `&session=${encodeURIComponent(next.id)}` : ''}`, {
          replace: true,
          state: { preserveNavigationDrawer: true },
        })
      }
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : t('chatSession.archiveFailed'))
    }
  }

  return {
    creatingSession,
    sessionError,
    clearSessionError: () => setSessionError(''),
    createSession,
    renameSession,
    deleteSession,
    archiveSession,
  }
}
