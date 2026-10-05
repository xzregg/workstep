type PushWatch = {
  projectId: string
  projectName: string
  sessionIds: string[]
  taskIds: string[]
}

let lastWatch = ''
let latestWatch: PushWatch | null = null

function available(): boolean {
  return !window.WorkStepAndroid && !window.workstepDesktop
    && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0)) as Uint8Array<ArrayBuffer>
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/completion-sw.js')
}

export async function browserPushEnabled(): Promise<boolean> {
  if (!available() || Notification.permission !== 'granted') return false
  const worker = await navigator.serviceWorker.getRegistration('/completion-sw.js')
  return Boolean(await worker?.pushManager.getSubscription())
}

export async function enableBrowserPush(): Promise<boolean> {
  if (!available()) return false
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false
  const response = await fetch('/api/completion-notifications/public-key')
  if (!response.ok) return false
  const { public_key: publicKey } = await response.json() as { public_key: string }
  const worker = await registration()
  const existing = await worker.pushManager.getSubscription()
  if (!existing) await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(publicKey),
  })
  lastWatch = ''
  if (latestWatch) await syncBrowserPush(latestWatch)
  return true
}

export async function syncBrowserPush(watch: PushWatch): Promise<void> {
  latestWatch = watch
  if (!available() || Notification.permission !== 'granted') return
  const key = JSON.stringify(watch)
  if (key === lastWatch) return
  const worker = await registration()
  const subscription = await worker.pushManager.getSubscription()
  if (!subscription) return
  const response = await fetch('/api/completion-notifications/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      project_id: watch.projectId,
      project_name: watch.projectName,
      session_ids: watch.sessionIds,
      task_ids: watch.taskIds,
    }),
  })
  if (!response.ok) throw new Error(`Push registration failed (${response.status})`)
  lastWatch = key
}

export async function clearBrowserPushWatch(): Promise<void> {
  latestWatch = null
  lastWatch = ''
  if (!available() || Notification.permission !== 'granted') return
  const worker = await navigator.serviceWorker.getRegistration('/completion-sw.js')
  const subscription = await worker?.pushManager.getSubscription()
  if (!subscription) return
  await fetch('/api/completion-notifications/subscriptions', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.toJSON().keys }),
  })
}
