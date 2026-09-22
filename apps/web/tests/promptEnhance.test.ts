import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PromptEnhancer,
  type PromptEnhancerDeps,
} from '../src/utils/promptEnhance.ts'

interface Harness {
  enhancer: PromptEnhancer
  state: { draft: string; projectId: string | undefined }
  setDraftCalls: string[]
  requests: Array<{ projectId: string; prompt: string }>
  errors: string[]
}

function createEnhancer(options: {
  draft?: string
  projectId?: string
  request?: (projectId: string, prompt: string) => Promise<{ prompt: string }>
} = {}): Harness {
  const state = {
    draft: options.draft ?? '',
    projectId: 'projectId' in options ? options.projectId : 'p1',
  }
  const setDraftCalls: string[] = []
  const requests: Array<{ projectId: string; prompt: string }> = []
  const errors: string[] = []
  const deps: PromptEnhancerDeps = {
    projectId: () => state.projectId,
    getDraft: () => state.draft,
    setDraft: (value) => {
      state.draft = value
      setDraftCalls.push(value)
    },
    onError: (message) => { errors.push(message) },
    errorMessage: () => '增强失败',
    enhanceRequest: async (projectId, prompt) => {
      requests.push({ projectId, prompt })
      return options.request
        ? options.request(projectId, prompt)
        : { prompt: `增强：${prompt}` }
    },
  }
  return { enhancer: new PromptEnhancer(deps), state, setDraftCalls, requests, errors }
}

test('empty draft does not trigger a request', async () => {
  const h = createEnhancer({ draft: '   ' })
  await h.enhancer.enhance()
  assert.equal(h.requests.length, 0)
  assert.equal(h.enhancer.getPhase(), 'idle')
})

test('missing project id disables enhance', async () => {
  const h = createEnhancer({ draft: 'hello', projectId: undefined })
  await h.enhancer.enhance()
  assert.equal(h.requests.length, 0)
  assert.equal(h.enhancer.getPhase(), 'idle')
})

test('enhance success rewrites the draft and can be reverted', async () => {
  const h = createEnhancer({ draft: '写一个测试' })
  await h.enhancer.enhance()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].prompt, '写一个测试')
  assert.equal(h.requests[0].projectId, 'p1')
  assert.deepEqual(h.setDraftCalls, ['增强：写一个测试'])
  assert.equal(h.enhancer.enhanced, true)
  assert.equal(h.enhancer.getPhase(), 'enhanced')

  h.enhancer.revert()
  assert.equal(h.state.draft, '写一个测试')
  assert.equal(h.enhancer.enhanced, false)
  assert.equal(h.enhancer.getPhase(), 'idle')
})

test('enhance failure surfaces the error and keeps the draft', async () => {
  const h = createEnhancer({
    draft: 'x',
    request: async () => { throw new Error('boom') },
  })
  await h.enhancer.enhance()
  assert.deepEqual(h.errors, ['boom'])
  assert.deepEqual(h.setDraftCalls, [])
  assert.equal(h.state.draft, 'x')
  assert.equal(h.enhancer.getPhase(), 'idle')
})

test('non-error failure falls back to the canned message', async () => {
  const h = createEnhancer({
    draft: 'x',
    request: async () => { throw 'raw' },
  })
  await h.enhancer.enhance()
  assert.deepEqual(h.errors, ['增强失败'])
})

test('repeated enhance calls while pending do not fire extra requests', async () => {
  let resolveRequest: (value: { prompt: string }) => void = () => {}
  const h = createEnhancer({
    draft: 'x',
    request: () => new Promise((resolve) => { resolveRequest = resolve }),
  })
  const first = h.enhancer.enhance()
  const second = h.enhancer.enhance()
  resolveRequest({ prompt: '增强：x' })
  await Promise.all([first, second])
  assert.equal(h.requests.length, 1)
  assert.equal(h.enhancer.enhanced, true)
})

test('editing the draft after enhance exits the enhanced state', async () => {
  const h = createEnhancer({ draft: 'hello' })
  await h.enhancer.enhance()
  assert.equal(h.enhancer.enhanced, true)

  h.enhancer.inputChanged('hello edited')
  assert.equal(h.enhancer.enhanced, false)
  assert.equal(h.enhancer.getPhase(), 'idle')
})

test('typing the same enhanced value keeps the enhanced state', async () => {
  const h = createEnhancer({ draft: 'hello' })
  await h.enhancer.enhance()
  h.enhancer.inputChanged('增强：hello')
  assert.equal(h.enhancer.enhanced, true)
})

test('reset clears the enhanced state', async () => {
  const h = createEnhancer({ draft: 'hello' })
  await h.enhancer.enhance()
  h.enhancer.reset()
  assert.equal(h.enhancer.enhanced, false)
  assert.equal(h.enhancer.getPhase(), 'idle')
})

test('phase changes notify subscribers', async () => {
  const h = createEnhancer({ draft: 'x' })
  const phases: string[] = []
  h.enhancer.subscribe(() => phases.push(h.enhancer.getPhase()))
  await h.enhancer.enhance()
  assert.deepEqual(phases, ['enhancing', 'enhanced'])
})
