import { createContext, useContext, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'

type Actions = { owner: symbol; children: ReactNode; beforeNew?: ReactNode } | null
const PublishContext = createContext<Dispatch<SetStateAction<Actions>> | null>(null)
const ActionsContext = createContext<Actions>(null)

/** The navigation renders exactly one action set, including during pane handoff. */
export function MobileHeaderActionsProvider({ children }: { children: ReactNode }) {
  const [actions, publish] = useState<Actions>(null)
  return <PublishContext.Provider value={publish}>
    <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
  </PublishContext.Provider>
}

export function MobileHeaderActionsSlot({ beforeNew = false }: { beforeNew?: boolean }) {
  const actions = useContext(ActionsContext)
  return <>{beforeNew ? actions?.beforeNew : actions?.children}</>
}

export default function MobileHeaderActions({ children, beforeNew }: { children: ReactNode; beforeNew?: ReactNode }) {
  const publish = useContext(PublishContext)
  const owner = useRef(Symbol('mobile-header-actions')).current
  useLayoutEffect(() => {
    publish?.({ owner, children, beforeNew })
    return () => publish?.(current => current?.owner === owner ? null : current)
  }, [publish, owner, children, beforeNew])
  return null
}
