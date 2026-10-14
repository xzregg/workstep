/** Defaults and clipboard content shared by desktop, local Web and Gateway. */
export function taskShareDefaults(now = Date.now()) {
  const random = new Uint8Array(18)
  globalThis.crypto.getRandomValues(random)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const password = Array.from(random, value => alphabet[value % alphabet.length]).join('')
  const expiry = new Date(now + 7 * 86400000)
  const expiresAt = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  return { password, expiresAt }
}

export const shareClipboardMessages = {
  'zh-CN': { address: '访问地址：', password: '访问密码：', task: '任务' },
  'en-US': { address: 'Access address: ', password: 'Access password: ', task: 'Task' },
  'zh-TW': { address: '存取位址：', password: '存取密碼：', task: '任務' },
  'ja-JP': { address: 'アクセス先：', password: 'アクセスパスワード：', task: 'タスク' },
}
export function shareClipboardLocale(locale: string) {
  return shareClipboardMessages[locale as keyof typeof shareClipboardMessages] || shareClipboardMessages['zh-CN']
}
export function taskShareClipboard(url: string, password: string, title: string, labels: { address: string; password: string; task: string }) {
  return `${title || labels.task}\n${labels.address}${url}${password ? `\n${labels.password}${password}` : ''}`
}

// Keep a just-created key available when its dialog is reopened in this app.
// The server stores the verification hash and never exposes keys to visitors.
const createdKeys = new Map<string, string>()
export function rememberTaskShareKey(id: string, password: string) { createdKeys.set(id, password) }
export function taskShareKey(id: string) { return createdKeys.get(id) || '' }
export function forgetTaskShareKey(id: string) { createdKeys.delete(id) }
