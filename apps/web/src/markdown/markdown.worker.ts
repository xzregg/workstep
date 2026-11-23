import { parseMarkdownTree } from './parseMarkdownTree'
self.onmessage = ({ data }: MessageEvent<{ id: number; content: string; incompleteCitation?: string; measure?: boolean }>) => {
  const start = data.measure ? performance.now() : undefined
  try {
    const tree = parseMarkdownTree(data.content, data.incompleteCitation)
    self.postMessage({ id: data.id, tree, ...(start !== undefined ? { parseMs: performance.now() - start } : {}) })
  }
  catch { self.postMessage({ id: data.id }) }
}
