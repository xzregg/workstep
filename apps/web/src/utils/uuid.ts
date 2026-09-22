/**
 * Cross-context unique id generation.
 *
 * `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost).
 * When the app is served over plain HTTP on a LAN address it is unavailable,
 * so callers must fall back instead of throwing `crypto.randomUUID is not a
 * function`.
 */

export function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return (
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}` +
      `-${hex.slice(16, 20)}-${hex.slice(20)}`
    )
  }
  return `id-${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 10)}`
}
