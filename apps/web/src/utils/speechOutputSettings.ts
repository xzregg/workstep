import { speechOutputApi, type OutputSettings } from '../api/speechOutput'

const requests = new Map<string, Promise<OutputSettings>>()
const invalidatedEvents = new WeakSet<Event>()

/** Replies and automatic speech share a single settings read per project. */
export function loadSpeechOutputSettings(projectId: string) {
  let request = requests.get(projectId)
  if (!request) {
    request = speechOutputApi.status(projectId).then(status => status.settings)
    requests.set(projectId, request)
    void request.catch(() => { if (requests.get(projectId) === request) requests.delete(projectId) })
  }
  return request
}

export function invalidateSpeechOutputSettings(event: Event) {
  if (!invalidatedEvents.has(event)) { invalidatedEvents.add(event); requests.clear() }
}
