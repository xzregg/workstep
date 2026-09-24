/**
 * Android System WebView versions before Chromium 123 ignore `light-dark()`.
 * Generated HTML artifacts often build all of their color variables from it,
 * which makes borders, backgrounds, and text styles appear to be missing.
 */
export function replaceLightDarkWithLightFallback(css: string): string {
  const marker = 'light-dark('
  let cursor = 0
  let output = ''

  while (cursor < css.length) {
    const start = css.indexOf(marker, cursor)
    if (start < 0) return output + css.slice(cursor)

    let depth = 0
    let comma = -1
    let end = -1
    for (let index = start + marker.length; index < css.length; index += 1) {
      const char = css[index]
      if (char === '(') depth += 1
      else if (char === ')') {
        if (depth === 0) {
          end = index
          break
        }
        depth -= 1
      } else if (char === ',' && depth === 0 && comma < 0) {
        comma = index
      }
    }

    if (comma < 0 || end < 0) return output + css.slice(cursor)
    output += css.slice(cursor, start)
    output += css.slice(start + marker.length, comma).trim()
    cursor = end + 1
  }
  return output
}

const preparedFrames = new WeakSet<HTMLIFrameElement>()

function prepareDocument(document: Document) {
  const supportsLightDark = document.defaultView?.CSS?.supports?.(
    'color',
    'light-dark(white, black)',
  ) ?? false
  if (!supportsLightDark) {
    document.querySelectorAll('style').forEach((style) => {
      style.textContent = replaceLightDarkWithLightFallback(style.textContent || '')
    })
  }

  document.querySelectorAll('iframe').forEach((frame) => {
    if (!preparedFrames.has(frame)) {
      preparedFrames.add(frame)
      frame.addEventListener('load', () => prepareFrame(frame))
    }
    prepareFrame(frame)
  })
}

export function prepareFrame(frame: HTMLIFrameElement) {
  try {
    if (frame.contentDocument) prepareDocument(frame.contentDocument)
  } catch {
    // Cross-origin or sandboxed child frames are intentionally inaccessible.
  }
}
