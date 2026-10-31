// Keep inline/fenced code intact, including a fence still arriving in a stream.
const TOKENS = /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[ \t]*(?=\r?$)|(?![\s\S])))|(`+)[^`]*?\3|:codex-file-citation\{((?:[^"{}]|"[^"]*")*)\}/gm

/** Adapt Codex output file directives to the shared Markdown file preview. */
export function convertFileCitations(content: string): string {
  return content.replace(TOKENS, (raw, fence, _delimiter, inline, attributes: string | undefined) => {
    if (fence || inline || attributes === undefined) return raw
    const path = /(?:^|\s)path="([^"]*)"(?:\s|$)/.exec(attributes)?.[1]
    if (!path || /[\r\n]/.test(path) || path.startsWith('//')) return raw
    const normalized = path.replace(/\\/g, '/')
    const windows = /^[a-z]:\//i.test(normalized)
    if (!windows && /^[a-z][a-z\d+.-]*:/i.test(normalized)) return raw
    const name = normalized.split('/').at(-1)
    if (!name) return raw
    const label = name.replace(/[\\[\]]/g, '\\$&')
    const encoded = encodeURIComponent(normalized)
      .replace(/%2F/gi, '/')
      .replace(/%3A/gi, ':')
      .replace(/[()]/g, (char) => char === '(' ? '%28' : '%29')
    const href = windows ? `file:///${encoded}` : encoded
    return `[${label}](${href})`
  })
}
