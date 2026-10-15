import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fsApi, type Project, type ReviewRun, type Task, type TaskArtifact, type TaskArtifactInputSnapshot } from '../api/client'
import type { SharedTaskApi, SharedTask } from '../api/share'
import type { TaskDetailReadCapabilities, TaskDetailGitCapability } from '../components/TaskDetailPage'
import type { ChatInputImageAttach } from '../components/ChatInput'
import { registerTaskShareTransport } from '../api/transport'
import TaskDetail from './TaskDetail'
import './SharedEditableTaskDetail.css'
import { sharedTaskArtifactFiles } from './sharedTaskFiles'
import { createGitApi } from '../api/git'
import { MarkdownAssetUrlProvider } from '../contexts/MarkdownAssetUrlContext'
import FilePreviewPage from './FilePreviewPage'

export interface SharedTaskDetailBinding {
  project: Project
  task: Task
  messages: any[]
  artifacts: TaskArtifact[]
  artifactDirectory: string
  inputSnapshots: TaskArtifactInputSnapshot[]
  reviews: ReviewRun[]
  readCapabilities: TaskDetailReadCapabilities
  gitCapability: TaskDetailGitCapability
  attachment: ChatInputImageAttach
  loadOlderHistory?: () => Promise<void>
}

/** Editable shares run the owner's task controller; only authentication and transport differ. */
export default function SharedEditableTaskDetail({ token, session, api, task, messages, artifacts,
  inputSnapshots = [], reviews, readCapabilities, gitCapability, attachment, loadOlderHistory, previewOnly = false,
}: {
  token: string; session: string; api: SharedTaskApi; task: SharedTask; messages: any[]
  artifacts: TaskArtifact[]; inputSnapshots?: TaskArtifactInputSnapshot[]; reviews: ReviewRun[]
  readCapabilities: TaskDetailReadCapabilities; gitCapability: TaskDetailGitCapability
  attachment: ChatInputImageAttach; loadOlderHistory?: () => Promise<void>; previewOnly?: boolean
}) {
  const bindingKey = `${token}:${session}:${task.id}`
  const [ready, setReady] = useState('')
  useEffect(() => {
    const unregister = registerTaskShareTransport(token, async <T,>(path: string, options?: RequestInit) => {
      const url = new URL(path, 'http://localhost')
      if ((!options?.method || options.method === 'GET') && url.pathname === `/task/${task.id}/history`) {
        return await api.history(token, session, Number(url.searchParams.get('limit') || 100),
          Number(url.searchParams.get('offset') || 0)) as T
      }
      if ((!options?.method || options.method === 'GET') && url.pathname === `/task/${task.id}/artifacts`) {
        const listing = await api.artifacts(token, session)
        return { ...listing, artifacts: sharedTaskArtifactFiles(listing.artifacts) } as T
      }
      url.searchParams.set('project_id', `share:${token}`)
      const result = await api.taskOperation<T>(token, session, url.pathname + url.search, options)
      if (options?.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
        window.dispatchEvent(new window.CustomEvent('workstep:shared-task-changed', { detail: { token } }))
      }
      return result
    })
    setReady(bindingKey)
    return unregister
  }, [api, token, session, task.id, bindingKey])
  const project = useMemo(() => ({
    id: `share:${token}`, name: task.title, path: 'workspace:', type: 'remote',
    steps: task.workflow?.steps || { nodes: task.steps.map(step => ({
      id: step.step_key, type: step.step_key, title: step.step_key,
    })) }, workflows: task.workflow ? [{ id: task.workflow.id, name: task.workflow.name, is_default: false, nodeCount: task.workflow.steps?.nodes?.length || 0 }] : [],
  } as Project), [token, task.title, task.workflow, task.steps])
  const editableGit = useMemo(() => ({ ...gitCapability,
    shared: false, api: createGitApi(), projectId: `share:${token}`, readOnly: false,
    workspaceEditable: true, projectScoped: true, allowedActions: undefined,
  }), [gitCapability.api, token])
  const latestRead = useRef({ readCapabilities, artifacts })
  latestRead.current = { readCapabilities, artifacts }
  const browseEditableWorkspace = useCallback(async (path: string, includeHidden: boolean) => {
      if (path.startsWith('artifact:')) return latestRead.current.readCapabilities.browseGitWorkspace(path, includeHidden)
      const listing = await fsApi.browse(path, project.id, includeHidden)
      if (!path.startsWith('workspace:')) return listing
      const current = path.replace(/\/$/, '')
      const virtualPath = (value: string) => current + (current === 'workspace:' ? '' : '/') + value.slice(listing.path.length).replace(/^\//, '')
      return { ...listing, path: current, relative_path: current,
        parent: current === 'workspace:' ? null : current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : 'workspace:',
        entries: listing.entries.map(entry => ({ ...entry, path: virtualPath(entry.path), relative_path: virtualPath(entry.path) })),
      }
    }, [project.id])
  const filePreview = useMemo(() => ({ ...readCapabilities.filePreview,
    load: (path: string) => path.startsWith('artifact:') || path.startsWith('workspace:') || latestRead.current.artifacts.some(item => item.source_path && path.replace(/\\/g, '/').endsWith('/artifacts/' + item.source_path))
      ? latestRead.current.readCapabilities.filePreview.load(path) : fsApi.preview(path, project.id),
  }), [readCapabilities.filePreview, project.id])
  const editableRead = useMemo(() => ({ ...readCapabilities,
    browseGitWorkspace: browseEditableWorkspace, filePreview,
  }), [readCapabilities, browseEditableWorkspace, filePreview])
  if (ready !== bindingKey) return null
  if (previewOnly) return <MarkdownAssetUrlProvider resolver={editableRead.resolveAssetUrl} filePreview={editableRead.filePreview}>
    <FilePreviewPage />
  </MarkdownAssetUrlProvider>
  return <TaskDetail taskId={task.id} onClose={() => window.close()} shared={{
    project, task: { ...task, cwd: "workspace:" }, messages, artifacts, inputSnapshots, reviews,
    artifactDirectory: readCapabilities.artifactDirectory, readCapabilities: editableRead, gitCapability: editableGit,
    attachment, loadOlderHistory,
  }} />
}
