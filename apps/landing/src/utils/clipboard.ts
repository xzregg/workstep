/**
 * Copy text to the clipboard, falling back to execCommand when the
 * Clipboard API is unavailable (e.g. non-secure origins like http://192.168.x.x
 * where `navigator.clipboard` is undefined, but localhost/127.0.0.1 work).
 *
 * Returns true when the text was copied, false otherwise.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission or serialization failure — fall through to the legacy path.
    }
  }
  return execCommandCopy(text)
}

function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.execCommand) return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  textarea.remove()
  return copied
}
