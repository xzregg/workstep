import { createContext, useContext, type ReactNode } from 'react'
import type { FilePreview } from '../api/client'

export type MarkdownUrlResolver = (src: string) => string

const MarkdownAssetUrlContext = createContext<MarkdownUrlResolver | undefined>(undefined)
export interface TaskFilePreview {
  load: (path: string) => Promise<FilePreview>
  rawUrl: (path: string) => string
}
const TaskFilePreviewContext = createContext<TaskFilePreview | undefined>(undefined)

export function MarkdownAssetUrlProvider({
  resolver,
  filePreview,
  children,
}: {
  resolver?: MarkdownUrlResolver
  filePreview?: TaskFilePreview
  children: ReactNode
}) {
  return (
    <MarkdownAssetUrlContext.Provider value={resolver}>
      <TaskFilePreviewContext.Provider value={filePreview}>
        {children}
      </TaskFilePreviewContext.Provider>
    </MarkdownAssetUrlContext.Provider>
  )
}

export function useMarkdownUrlResolver() {
  return useContext(MarkdownAssetUrlContext)
}

export function useTaskFilePreview() {
  return useContext(TaskFilePreviewContext)
}
