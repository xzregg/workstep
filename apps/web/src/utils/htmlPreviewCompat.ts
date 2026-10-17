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
export const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads'

/** Keep fragment navigation within an opaque srcdoc rather than the share URL. */
export function isolatedHtmlDocument(content: string): string {
  // This comes before untrusted markup: its scripts cannot loosen the policy.
  // No ambient API/file access for shares or older backends without resource tickets.
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src blob: data:; worker-src 'none'; base-uri 'none'; form-action 'none'"
  const restriction = `<meta http-equiv="Content-Security-Policy" content="${policy}">`
  const doctype = content.match(/^[\s\uFEFF]*<!doctype[^>]*>/i)?.[0] || ''
  const source = doctype + restriction + content.slice(doctype.length)
  return source + `<script>
document.addEventListener('click', function (event) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  var link = event.target instanceof Element && event.target.closest('a[href^="#"]');
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  var id;
  try { id = decodeURIComponent(link.getAttribute('href').slice(1)); } catch (_) { return; }
  var target = id ? document.getElementById(id) || document.getElementsByName(id)[0] : document.documentElement;
  if (target) { event.preventDefault(); target.scrollIntoView(); }
});
</script>`
}

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
