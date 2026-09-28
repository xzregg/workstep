import { useCallback, useEffect, useRef, useState } from 'react'
import { fsApi, taskApi, type TaskArtifact, type TaskArtifactInputSnapshot } from '../api/client'
import { useI18n } from '../i18n'
import { findPreferredArtifact } from '../pages/taskArtifactRules'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'

interface Options {
  taskId: string
  projectId: string
  steps?: readonly unknown[]
  remote: boolean
}

/** Owns a task's artifact snapshot, preview selection, refresh, and directory feedback. */
export function useTaskArtifacts({ taskId, projectId, steps, remote }: Options) {
  const { t } = useI18n()
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([])
  const [artifactDirectory, setArtifactDirectory] = useState('')
  const [inputSnapshots, setInputSnapshots] = useState<TaskArtifactInputSnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [previewArtifact, setPreviewArtifact] = useState<TaskArtifact | null>(null)
  const [notice, setNotice] = useState('')
  const identity = `${projectId}:${taskId}`
  const identityRef = useRef(identity)
  identityRef.current = identity
  const pendingRef = useRef<{ identity: string; promise: Promise<TaskArtifact[]> } | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
  }, [])

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    setNotice(message)
    noticeTimerRef.current = setTimeout(() => setNotice(''), 3000)
  }, [])

  const refreshArtifacts = useCallback((): Promise<TaskArtifact[]> => {
    if (!taskId || !projectId) {
      setArtifacts([])
      setArtifactDirectory('')
      setInputSnapshots([])
      return Promise.resolve([])
    }
    if (pendingRef.current?.identity === identity) return pendingRef.current.promise
    const promise = taskApi.artifacts(taskId, projectId).then((response) => {
      const fresh = response.artifacts || []
      if (identityRef.current === identity) {
        setArtifacts(fresh)
        setArtifactDirectory(response.artifact_directory || '')
        setInputSnapshots(response.input_snapshots || [])
      }
      return fresh
    }).catch(() => {
      if (identityRef.current === identity) {
        setArtifacts([])
        setArtifactDirectory('')
        setInputSnapshots([])
      }
      return []
    }).finally(() => {
      if (pendingRef.current?.promise === promise) pendingRef.current = null
    })
    pendingRef.current = { identity, promise }
    return promise
  }, [taskId, projectId, identity])

  useEffect(() => {
    if (!taskId || !projectId) {
      setArtifacts([])
      setArtifactDirectory('')
      setInputSnapshots([])
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    void refreshArtifacts().finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [taskId, projectId, steps, refreshArtifacts])

  const openArtifact = useCallback(async (
    name: string, preferredStepKey?: string, round?: number, path?: string,
  ) => {
    const current = findPreferredArtifact(artifacts, name, preferredStepKey, round, path)
    if (current) {
      setPreviewArtifact(current)
      setNotice('')
      return
    }
    if (!taskId || !projectId) return
    setNotice(t('taskDetail.artifactLoading'))
    const fresh = await refreshArtifacts()
    if (identityRef.current !== identity) return
    const latest = findPreferredArtifact(fresh, name, preferredStepKey, round, path)
    if (latest) {
      setPreviewArtifact(latest)
      setNotice('')
    } else {
      showNotice(t('taskDetail.artifactNotFound', { name }))
    }
  }, [artifacts, taskId, projectId, identity, refreshArtifacts, showNotice, t])

  const openArtifactDirectory = useCallback(async () => {
    if (!previewArtifact || remote || isGatewayRemoteBrowser()) return
    try {
      const result = await fsApi.openDirectory(previewArtifact.path)
      showNotice(t('taskDetail.directoryOpened', { path: result.path }))
    } catch (error) {
      showNotice(t('taskDetail.directoryOpenFailed', {
        error: error instanceof Error ? error.message : t('common.unknownError'),
      }))
    }
  }, [previewArtifact, remote, showNotice, t])

  return {
    artifacts, artifactDirectory, inputSnapshots, loading,
    previewArtifact, closePreview: () => setPreviewArtifact(null),
    notice, openArtifact, openArtifactDirectory,
  }
}
