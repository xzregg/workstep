import { createContext, useContext, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'

type Actions = { owner: symbol; children: ReactNode } | null
const PublishContext = createContext<Dispatch<SetStateAction<Actions>> | null>(null)
const ActionsContext = createContext<ReactNode>(null)

/** The navigation renders exactly one action set, including during pane handoff. */
export function MobileHeaderActionsProvider({ children }: { children: ReactNode }) {
  const [actions, publish] = useState<Actions>(null)
  return <PublishContext.Provider value={publish}>
    <ActionsContext.Provider value={actions?.children}>{children}</ActionsContext.Provider>
  </PublishContext.Provider>
}

export function MobileHeaderActionsSlot() {
  return <>{useContext(ActionsContext)}</>
}

export default function MobileHeaderActions({ children }: { children: ReactNode }) {
  const publish = useContext(PublishContext)
  const owner = useRef(Symbol('mobile-header-actions')).current
  useLayoutEffect(() => {
    publish?.({ owner, children })
    return () => publish?.(current => current?.owner === owner ? null : current)
  }, [publish, owner, children])
  return null
}
