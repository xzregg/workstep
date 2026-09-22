import { createContext, useContext, type ReactNode } from 'react'

export type MarkdownUrlResolver = (src: string) => string

const MarkdownAssetUrlContext = createContext<MarkdownUrlResolver | undefined>(undefined)

export function MarkdownAssetUrlProvider({
  resolver,
  children,
}: {
  resolver?: MarkdownUrlResolver
  children: ReactNode
}) {
  return (
    <MarkdownAssetUrlContext.Provider value={resolver}>
      {children}
    </MarkdownAssetUrlContext.Provider>
  )
}

export function useMarkdownUrlResolver() {
  return useContext(MarkdownAssetUrlContext)
}
