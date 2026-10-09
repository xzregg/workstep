export function openRemoteAccess(access: { url: string; ticket: string; next?: string }, target?: string) {
  const form = document.createElement('form')
  if (target) form.target = target
  form.method = 'POST'
  form.action = new URL('api/remote/redeem', access.url).toString()
  const ticket = document.createElement('input')
  ticket.type = 'hidden'
  ticket.name = 'ticket'
  ticket.value = access.ticket
  form.append(ticket)
  if (access.next) {
    const next = document.createElement('input')
    next.type = 'hidden'; next.name = 'next'; next.value = access.next
    form.append(next)
  }
  document.body.append(form)
  form.submit()
  form.remove()
}
