import { useEffect } from 'react'
import { create } from 'zustand'

export interface DesktopUpdateStatus {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  checkedAt: number
  source: 'cache' | 'network'
}

export interface DesktopUpdateBridge {
  status: () => Promise<DesktopUpdateStatus>
  check: () => Promise<DesktopUpdateStatus>
  openDownload: (url: string) => Promise<void>
  start?: () => Promise<void>
  autoStatus?: () => Promise<DesktopAutoUpdateStatus>
}

export interface DesktopAutoUpdateStatus {
  phase: 'idle' | 'checking' | 'downloading' | 'installing' | 'error'
  percent: number
  error: string | null
}

const idle: DesktopAutoUpdateStatus = { phase: 'idle', percent: 0, error: null }
const initial = { status: null as DesktopUpdateStatus | null, checking: false, failed: false, automatic: idle }
const busyPhase = (state: DesktopAutoUpdateStatus) => ['checking', 'downloading', 'installing'].includes(state.phase)
let bridge: DesktopUpdateBridge | undefined
let clients = 0, generation = 0, lastStatusRead = 0
let timer: ReturnType<typeof setTimeout> | undefined
let statusPending: Promise<void> | undefined
let autoPending: Promise<void> | undefined
let starting = false

export const useDesktopUpdateStore = create(() => ({ ...initial }))

async function refreshAutomatic() {
  if (!bridge?.autoStatus) return
  if (autoPending) return autoPending
  const current = generation, source = bridge
  autoPending = source.autoStatus!().then(automatic => {
    if (current !== generation) return
    const previous = useDesktopUpdateStore.getState().automatic
    if (automatic.phase === 'idle' && starting) return
    if (automatic.phase !== 'idle' || previous.phase !== 'error') useDesktopUpdateStore.setState({ automatic })
  }).catch(() => { /* IPC may disconnect during restart. */ }).finally(() => {
    if (current === generation) autoPending = undefined
  })
  return autoPending
}

async function refreshStatus(force = false) {
  if (!bridge) return
  if (statusPending) return statusPending
  const current = generation, source = bridge
  useDesktopUpdateStore.setState({ checking: force, failed: false })
  lastStatusRead = Date.now()
  statusPending = (force ? source.check() : source.status()).then(status => {
    if (current === generation) useDesktopUpdateStore.setState({ status })
  }).catch(() => {
    if (current === generation) useDesktopUpdateStore.setState({ failed: true })
  }).finally(() => {
    if (current === generation) { statusPending = undefined; useDesktopUpdateStore.setState({ checking: false }) }
  })
  return statusPending
}

function connect(updates: DesktopUpdateBridge | undefined) {
  if (!updates) return () => {}
  clients++
  if (clients === 1) {
    bridge = updates
    const current = ++generation
    statusPending = undefined; autoPending = undefined; lastStatusRead = 0; starting = false
    useDesktopUpdateStore.setState({ ...initial })
    const poll = async () => {
      await Promise.all([refreshAutomatic(), Date.now() - lastStatusRead >= 60_000 ? refreshStatus() : undefined])
      if (current === generation) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
  }
  return () => {
    if (--clients === 0) { generation++; clearTimeout(timer); bridge = undefined }
  }
}

async function start() {
  const source = bridge
  const state = useDesktopUpdateStore.getState()
  if (!source?.start || starting || busyPhase(state.automatic) || state.checking) return
  const current = generation
  useDesktopUpdateStore.setState({ automatic: { ...idle, phase: 'checking' } })
  starting = true
  try {
    const pending = source.start()
    void refreshAutomatic()
    await pending
    if (current === generation) {
      starting = false
      await refreshAutomatic()
      if (!busyPhase(useDesktopUpdateStore.getState().automatic)) await refreshStatus()
    }
  } catch (error) {
    if (current === generation) useDesktopUpdateStore.setState({ automatic: {
      phase: 'error', percent: 0, error: error instanceof Error ? error.message : String(error),
    } })
  } finally { if (current === generation) starting = false }
}

const check = () => busyPhase(useDesktopUpdateStore.getState().automatic) ? Promise.resolve() : refreshStatus(true)

/** Both update entries share one watcher and one in-flight request per IPC. */
export function useDesktopUpdates() {
  const updates = window.workstepDesktop?.updates
  const state = useDesktopUpdateStore()
  useEffect(() => connect(updates), [updates])
  return { ...state, updates, busy: busyPhase(state.automatic), check, start }
}
