import { create } from 'zustand'
import { gitApi, type GitDiscovery, type ScanJob } from '../api/git'
let scanning: Promise<void> | null = null
let requestedKey = ''
interface GitStore {
  data: GitDiscovery | null; job: ScanJob | null; error: string; scanning: boolean
  referenceVersion: number; referencesChanged: () => void
  scan: (key?: string) => Promise<void>
}
export const useGitStore = create<GitStore>(set => ({
  data: null, job: null, error: '', scanning: false,
  referenceVersion: 0, referencesChanged: () => set(s => ({ referenceVersion: s.referenceVersion + 1 })),
  scan: (key?: string) => {
    if (key !== undefined) requestedKey = key
    if (scanning) return scanning
    set({ scanning: true, error: '' })
    scanning = (async () => {
      try {
        let completedKey: string
        do {
          completedKey = requestedKey
          let job = await gitApi.scan()
          set({ job })
          while (job.state === 'running') {
            await new Promise(resolve => setTimeout(resolve, 600))
            job = await gitApi.progress(job.id)
            set({ job })
          }
          if (job.state === 'failed') throw new Error(job.error)
          set({ data: await gitApi.repositories() })
        } while (completedKey !== requestedKey)
      } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }) }
      finally { scanning = null; set({ scanning: false }) }
    })()
    return scanning
  },
}))
