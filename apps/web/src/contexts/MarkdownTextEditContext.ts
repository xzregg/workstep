import { createContext } from 'react'

export const MarkdownTextEditContext = createContext<{
  label: string
  replace: (start: number, end: number, text: string) => boolean
} | null>(null)

