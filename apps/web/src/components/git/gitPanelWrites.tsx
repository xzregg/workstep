import { createContext, useContext, useSyncExternalStore } from 'react'

export class GitPanelBusyError extends Error {
  constructor() { super('Git panel write already in progress') }
}

export interface PanelGitWrites {
  run<T>(write: () => Promise<T>): Promise<T>
  isBusy(): boolean
  subscribe(listener: () => void): () => void
}

export function createPanelGitWrites(): PanelGitWrites {
  let busy = false
  const listeners = new Set<() => void>()
  const publish = () => listeners.forEach(listener => listener())
  return {
    isBusy: () => busy,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async run(write) {
      if (busy) throw new GitPanelBusyError()
      busy = true
      publish()
      try { return await write() }
      finally { busy = false; publish() }
    },
  }
}

const directWrites: PanelGitWrites = {
  run: write => write(),
  isBusy: () => false,
  subscribe: () => () => {},
}

export const PanelGitWritesContext = createContext<PanelGitWrites>(directWrites)

export function usePanelGitWrites() {
  const writes = useContext(PanelGitWritesContext)
  const busy = useSyncExternalStore(writes.subscribe, writes.isBusy)
  return { run: writes.run, busy }
}
