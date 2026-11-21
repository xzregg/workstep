import { parseMarkdownTree } from './parseMarkdownTree'
self.onmessage = ({ data }: MessageEvent<{ id: number; content: string; incompleteCitation?: string }>) => {
  try { self.postMessage({ id: data.id, tree: parseMarkdownTree(data.content, data.incompleteCitation) }) }
  catch { self.postMessage({ id: data.id }) }
}
