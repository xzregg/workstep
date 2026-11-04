export function limitFeedbackText(value, maxBytes = 8192) {
  const bytes = new TextEncoder().encode(value)
  return bytes.length <= maxBytes ? value : new TextDecoder().decode(bytes.subarray(0, maxBytes - 4), { stream: true }) + '…'
}

function compactError(detail) {
  const lines = detail.split('\n').filter(line => line.trim())
  const python = /^\s*Traceback\b/.test(lines[0] || '')
  const headline = python ? lines.findLast(line => /^[\w.]*(?:Error|Exception):/.test(line.trim())) || lines[0] : lines[0]
  const frames = lines.filter(line => /^\s*(?:at\s|File\s)/.test(line)).slice(0, 2)
  return limitFeedbackText([headline, ...frames].join('\n'), 600)
}

export function summarizeErrors(records) {
  const recent = records.map((record, index) => ({ ...record, index, detail: compactError(record.detail) }))
    .filter(record => record.detail)
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || b.index - a.index)
  const seen = new Set(), summaries = []
  for (const record of recent) {
    const key = `${record.source}:${record.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    summaries.push(`${record.at || '时间不可用'} [${record.source}] ${record.detail}`)
    if (summaries.length === 5) break
  }
  return summaries
}

export function extractLogErrors(logs = {}) {
  const records = []
  // Rotated files are scanned oldest first; timestamps decide final ordering.
  const files = Object.entries(logs).sort(([a], [b]) => {
    const rotation = (Number(b.match(/\.(\d+)$/)?.[1]) || 0) - (Number(a.match(/\.(\d+)$/)?.[1]) || 0)
    return rotation || a.localeCompare(b)
  })
  for (const [file, content] of files) {
    const source = file.startsWith('daemon') ? '后台' : file.startsWith('sandbox') ? '沙箱' : '桌面'
    let current = null
    function flush() {
      if (current) records.push({ at: current.at, source, detail: current.lines.join('\n') })
      current = null
    }
    for (const raw of String(content).split('\n')) {
      if (file.startsWith('sandbox') && raw.trim().startsWith('{')) {
        try {
          const entry = JSON.parse(raw)
          if ('phase' in entry) {
            flush()
            if (typeof entry.error === 'string' && entry.error || entry.phase === 'error') records.push({ at: entry.time || '', source, detail: typeof entry.error === 'string' ? entry.error : '沙箱启动失败' })
            continue
          }
        } catch { /* Partial rotated JSON falls through to error recognition. */ }
      }
      const match = /^\[?(\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:\d\d)?)\]?\s+(info|debug|warn|warning|error|fatal)\s+(.*)$/i.exec(raw)
      const [, at = '', level = '', message = raw] = match || []
      if (/^\s*(?:INFO|DEBUG|WARN(?:ING)?)\b[:\s]/i.test(message)) { flush(); continue }
      if (/^(info|debug)$/i.test(level) && !/^\s*(?:Traceback\b|[\w.]*(?:Error|Exception):|ERROR\b|FATAL\b)|报错|无响应/i.test(message)) { flush(); continue }
      const continuation = /^\s+(?:at\s|File\s|raise\s|\S)/.test(message)
      const pythonEnd = current?.python && /^[\w.]*(?:Error|Exception):/.test(message.trim())
      if (current && (continuation || pythonEnd) && (!level || /error|fatal/i.test(level))) {
        current.lines.push(message)
        // Preserve the beginning of the traceback and its final exception.
        if (current.lines.length > 8) current.lines.splice(4, 1)
        if (at) current.at = at
        continue
      }
      flush()
      const failure = /\b(?:error|fatal|exception|traceback|failed|failure)\b|\w+(?:Error|Exception):|报错|异常|失败|无响应|"expected":false/i.test(message)
      if (/^(error|fatal)$/i.test(level) || failure) current = { at, lines: [message], python: /Traceback/.test(message) }
    }
    flush()
  }
  return records
}
