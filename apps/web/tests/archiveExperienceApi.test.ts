import { useLocaleStore } from '../src/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import { taskApi } from '../src/api/task'

const draft = { message_id: 'draft-1', experience: '- Error: x; Cause: y; Fix: z.', has_experience: true, cached: false }

test('archive preparation retries a disconnected short request with the same generation ID', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const previousLocale = useLocaleStore.getState().locale
  useLocaleStore.setState({locale: "ja-JP"})
  t.after(() => useLocaleStore.setState({locale: previousLocale}))
  const bodies: string[] = []
  const urls: string[] = []
  globalThis.fetch = async (input, options) => {
    bodies.push(String(options?.body))
    useLocaleStore.setState({locale: "de-DE"})
    urls.push(String(input))
    if (urls.length === 1) return Response.json({ detail: 'Remote project disconnected' }, { status: 502 })
    if (urls.length === 2) return Response.json({ status: 'running', message_id: 'draft-1' }, { status: 202 })
    return Response.json(draft)
  }
  assert.deepEqual(await taskApi.prepareArchiveExperience('task', 'project', 'draft-1'), draft)
  assert.equal(urls.length, 3)
  assert.equal(new Set(urls).size, 1)
  assert.match(urls[0], /background=true/)
  assert.equal(new Set(bodies).size, 1)
  assert.equal(JSON.parse(bodies[0]).locale, "ja-JP")
})

test('archive polling preserves stopped and model errors without restarting generation', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ detail: 'Archive experience generation stopped' }, { status: 409 })
  }
  await assert.rejects(taskApi.prepareArchiveExperience('task', 'project', 'draft-1'), /stopped/)
  assert.equal(calls, 1)
})

test('archive preparation still accepts the completed response from older daemons', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => Response.json(draft)
  assert.deepEqual(await taskApi.prepareArchiveExperience('task', 'project', 'draft-1'), draft)
})
