import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { Project } from '../api/client'
import { useProjectStore } from '../stores/projectStore'
import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'
import './DesktopProjectDrop.css'

interface ProjectDropBridge {
  pathForFile(file: File): string
  resolveDirectory(path: string): Promise<string>
}

function bridge(): ProjectDropBridge | undefined {
  return (window as unknown as { workstepDesktop?: { projects?: ProjectDropBridge } }).workstepDesktop?.projects
}

function directoryItems(event: DragEvent) {
  return Array.from(event.dataTransfer?.items ?? []).filter(item =>
    item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory,
  )
}

/** Capture folder drops before attachment inputs or sidebar reorder handlers. */
export default function DesktopProjectDrop({ onSelectProject }: { onSelectProject: (project: Project) => void }) {
  const { t } = useI18n()
  const [hover, setHover] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const locked = useRef(false)
  const select = useRef(onSelectProject)
  select.current = onSelectProject

  async function open(paths: string[]) {
    setPending(null)
    setBusy(true)
    try {
      const desktop = bridge()!
      for (const hostPath of paths) {
        const path = await desktop.resolveDirectory(hostPath)
        const store = useProjectStore.getState()
        const existing = store.projects.find(project => project.type !== 'remote' && project.path === path)
        const project = existing ?? await store.initProject(path)
        store.setCanvasDirty(false)
        store.setActiveProject(project)
        select.current(project)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('desktopDrop.failed'))
    } finally {
      locked.current = false
      setBusy(false)
    }
  }

  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (!bridge()) return
    const drag = (event: DragEvent) => {
      // Chromium hides entries during dragover; allow the drop using Files,
      // then inspect actual entries in drop before claiming the event.
      if (!bridge() || !Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
      event.preventDefault()
      if (!directoryItems(event).length) return
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setHover(true)
    }
    const leave = (event: DragEvent) => { if (!event.relatedTarget) setHover(false) }
    const drop = (event: DragEvent) => {
      const desktop = bridge()
      const items = directoryItems(event)
      if (!desktop || !items.length) return
      event.preventDefault()
      event.stopPropagation()
      setHover(false)
      if (locked.current) return
      locked.current = true
      try {
        const paths = [...new Set(items.map(item => {
          const file = item.getAsFile()
          const path = file && desktop.pathForFile(file)
          if (!path) throw new Error(t('desktopDrop.failed'))
          return path
        }))]
        if (useProjectStore.getState().canvasDirty) setPending(paths)
        else void openRef.current(paths)
      } catch (cause) {
        locked.current = false
        setError(cause instanceof Error ? cause.message : t('desktopDrop.failed'))
      }
    }
    window.addEventListener('dragenter', drag, true)
    window.addEventListener('dragover', drag, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    return () => {
      window.removeEventListener('dragenter', drag, true)
      window.removeEventListener('dragover', drag, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
    }
  }, [t])

  return <>
    {(hover || busy) && <div className="desktop-project-drop" role="status">
      {busy && <LoaderCircle className="desktop-project-drop-spinner" size={20} />}
      {t(busy ? 'desktopDrop.opening' : 'desktopDrop.hint')}
    </div>}
    <ConfirmDialog open={!!pending} title={t('canvas.unsavedTitle')} message={t('canvas.unsavedSwitchMessage')}
      onConfirm={() => { if (pending) void open(pending) }}
      onCancel={() => { setPending(null); locked.current = false }} />
    <ConfirmDialog open={!!error} title={t('desktopDrop.failed')} message={error}
      onConfirm={() => setError('')} onCancel={() => setError('')} />
  </>
}
