self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const payload = event.data?.json()
    if (!payload?.id || !payload?.url) return
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (windows.some((client) => client.visibilityState === 'visible')) return
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.id,
      data: { url: payload.url },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || '/', self.location.origin)
    if (target.origin !== self.location.origin) return
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find((client) => new URL(client.url).origin === target.origin)
    if (existing) {
      await existing.navigate(target.href)
      await existing.focus()
    } else {
      await self.clients.openWindow(target.href)
    }
  })())
})
