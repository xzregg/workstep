import { digitalPersonApi } from '../../api/digitalPerson'

const pending = new Map<string, Promise<string>>()

/** Resolve the persisted device main session; never enter a channel peer's chat. */
export function resolveDigitalPersonChat(projectId: string): Promise<string> {
  const current = pending.get(projectId)
  if (current) return current
  const request = digitalPersonApi.mainSession().then(session => {
    if (session.project_id !== projectId) throw new Error('Digital human workspace has changed, please refresh and try again')
    return session.id
  }).finally(() => pending.delete(projectId))
  pending.set(projectId, request)
  return request
}
