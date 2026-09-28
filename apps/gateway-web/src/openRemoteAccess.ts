export function openRemoteAccess(access: { url: string; ticket: string }) {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = new URL('api/remote/redeem', access.url).toString()
  const ticket = document.createElement('input')
  ticket.type = 'hidden'
  ticket.name = 'ticket'
  ticket.value = access.ticket
  form.append(ticket)
  document.body.append(form)
  form.submit()
  form.remove()
}
