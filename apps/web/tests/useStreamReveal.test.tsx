import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { StrictMode, act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import useStreamReveal, {
  MAX_CATCH_UP_FRAMES,
  MAX_REVEAL_DURATION_MS,
  MIN_REVEAL_FRAME_MS,
  REVEAL_STEP_CHARS,
  revealStepFor,
} from '../src/hooks/useStreamReveal.ts'

let outputs: string[] = []

function Harness({
  content,
  streaming = false,
  frozen = false,
  enabled = true,
}: {
  content: string
  streaming?: boolean
  frozen?: boolean
  enabled?: boolean
}) {
  const out = useStreamReveal(content, streaming, frozen, enabled)
  useEffect(() => {
    outputs.push(out)
  }, [out])
  return null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const renderHarness = async (props: {
  content: string
  streaming?: boolean
  frozen?: boolean
  enabled?: boolean
}) => {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  renderHarness.currentProps = props
  await act(async () => {
    root.render(<Harness {...props} />)
  })
  return {
    root,
    host,
    set: async (next: Partial<typeof props>) => {
      renderHarness.currentProps = { ...renderHarness.currentProps, ...next }
      await act(async () => {
        root.render(<Harness {...renderHarness.currentProps} />)
      })
    },
    unmount: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}
renderHarness.currentProps = { content: '' }

// 等揭示收敛：输出须连续稳定超过一个 tick 间隔（90ms）才算收敛，
// 避免采样间隔（30ms）短于 tick 间隔时把"帧间隙"误判为收敛
const waitForSettle = async (timeoutMs = 4000) => {
  const start = Date.now()
  let prev = ''
  let stableSince: number | null = null
  while (Date.now() - start < timeoutMs) {
    await act(async () => {
      await sleep(30)
    })
    const cur = outputs[outputs.length - 1] ?? ''
    if (cur && cur === prev) {
      stableSince = stableSince ?? Date.now()
      if (Date.now() - stableSince >= 150) return cur
    } else {
      stableSince = null
    }
    prev = cur
  }
  return outputs[outputs.length - 1]
}

test('passes through immediately when not streaming', async () => {
  outputs = []
  const h = await renderHarness({ content: 'abc' })
  assert.equal(outputs[outputs.length - 1], 'abc')
  const count = outputs.length
  await sleep(250)
  assert.equal(outputs.length, count, 'no extra renders after pass-through')
  await h.unmount()
})

test('shows preloaded running history immediately instead of replaying its text', async () => {
  outputs = []
  const h = await renderHarness({ content: '刷新前已经显示的历史正文', streaming: true })
  assert.equal(outputs[outputs.length - 1], '刷新前已经显示的历史正文')
  const count = outputs.length
  await sleep(250)
  assert.equal(outputs.length, count, 'preloaded history must not schedule reveal frames')
  await h.unmount()
})

test('passes through when reveal disabled', async () => {
  outputs = []
  const h = await renderHarness({ content: 'abcdef', streaming: true, enabled: false })
  assert.equal(outputs[outputs.length - 1], 'abcdef')
  await sleep(250)
  assert.equal(outputs.length, 1, 'disabled = no tick renders')
  await h.unmount()
})

test('converges to full content while streaming', async () => {
  outputs = []
  const h = await renderHarness({ content: '', streaming: true })
  assert.equal(outputs[0], '', 'first mount in stream starts empty')
  await h.set({ content: 'abcdefgh' })
  const settled = await waitForSettle()
  assert.equal(settled, 'abcdefgh')
  // 收敛后不再揭示（性能红线：不能一直重画）
  const count = outputs.length
  await sleep(300)
  assert.equal(outputs.length, count, 'no ticks after convergence')
  await h.unmount()
})

test('content replacement (non-extension) resets to full content immediately', async () => {
  outputs = []
  const h = await renderHarness({ content: 'abcdef', streaming: true })
  await waitForSettle()
  outputs = []
  await h.set({ content: 'completely different' })
  assert.equal(outputs[outputs.length - 1], 'completely different')
  await h.unmount()
})

test('streaming end keeps draining instead of jumping to full', async () => {
  outputs = []
  const text = 'a'.repeat(60)
  const h = await renderHarness({ content: '', streaming: true })
  await h.set({ content: text })
  // 常规节奏：每帧 REVEAL_STEP_CHARS 字，90ms 一帧；120ms 后应仍在揭示中途
  await act(async () => { await sleep(120) })
  const partial = outputs[outputs.length - 1]
  assert.ok(partial.length > 0 && partial.length < 60, `expected partial, got ${partial.length}`)
  await h.set({ streaming: false })
  // 结束后不能瞬间跳满，仍按同一节奏继续排空
  assert.ok(outputs[outputs.length - 1].length < 60, 'must not jump to full on stream end')
  const settled = await waitForSettle()
  assert.equal(settled, text)
  await h.unmount()
})

test('a long burst still reveals gradually instead of appearing at once', async () => {
  outputs = []
  const longText = 'a'.repeat(5000)
  const h = await renderHarness({ content: '', streaming: true })
  await h.set({ content: longText })
  await act(async () => { await sleep(300) })
  const partial = outputs[outputs.length - 1]
  // 5000 字按 120 字/秒，300ms 只能揭示一小部分
  assert.ok(
    partial.length > 0 && partial.length < 500,
    `expected slow reveal, got ${partial.length} chars after 300ms`,
  )
  await h.unmount()
})

test('selection freeze holds output; release flushes immediately', async () => {
  outputs = []
  const h = await renderHarness({ content: 'abc', streaming: true })
  await waitForSettle()
  const countAfterSettle = outputs.length
  // 冻结：输入是快照（content 不变），输出保持稳定
  await h.set({ frozen: true })
  assert.equal(outputs[outputs.length - 1], 'abc')
  await sleep(250)
  assert.equal(outputs.length, countAfterSettle, 'no ticks while frozen')
  // 释放冻结：父级把内容换成全量 → 立即追平
  await h.set({ content: 'abcdef', frozen: false })
  assert.equal(outputs[outputs.length - 1], 'abcdef')
  await h.unmount()
})

test('still reveals while streaming after StrictMode cleanup + re-setup', async () => {
  outputs = []
  const strictText = 'a'.repeat(60)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  // StrictMode 在开发环境会"挂载→清理→再挂载"执行 effect（同一实例、同一 ref）。
  // 清理若不置空 timerRef，重挂载后守卫恒为 false，正文会一直空白到 streaming 结束。
  await act(async () => {
    root.render(<StrictMode><Harness content="" streaming /></StrictMode>)
  })
  await act(async () => {
    root.render(<StrictMode><Harness content={strictText} streaming /></StrictMode>)
  })
  const settled = await waitForSettle()
  assert.equal(settled, strictText, 'StrictMode 下仍应逐帧揭示到全量')
  // 中途必须出现过"部分揭示"的中间态，而不是最后的瞬间全量
  const sawPartial = outputs.some((out) => out.length > 0 && out.length < strictText.length)
  assert.ok(sawPartial, `expected a partial reveal frame, got ${JSON.stringify(outputs)}`)
  await act(async () => root.unmount())
  host.remove()
})

test('keeps revealing as new tokens arrive incrementally', async () => {
  outputs = []
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const props = { content: '', streaming: true }
  const render = async (next: typeof props) => {
    await act(async () => {
      root.render(<StrictMode><Harness {...next} /></StrictMode>)
    })
  }
  await render({ ...props })
  for (const piece of ['ni', 'hao', '-', 'zhe', 'shi', '-', 'zheng', 'wen']) {
    props.content += piece
    await render({ ...props })
    await sleep(60)
  }
  await waitForSettle()
  assert.equal(outputs[outputs.length - 1], props.content)
  // 流式期间必须出现多个逐步增长的中间态，而不是最后一次性全量
  const partials = outputs.filter((out) => out.length > 0 && out.length < props.content.length)
  assert.ok(partials.length >= 2, `expected progressive reveal frames, got ${JSON.stringify(outputs)}`)
  await act(async () => root.unmount())
  host.remove()
})

test('catch-up pacing keeps a long backlog within the 10s budget', () => {
  const total = 5000
  let shown = 0
  let step = REVEAL_STEP_CHARS
  let ticks = 0
  while (shown < total) {
    const remaining = total - shown
    step = revealStepFor(remaining, step)
    shown += Math.min(remaining, step)
    ticks += 1
    assert.ok(ticks <= MAX_CATCH_UP_FRAMES + 1, 'must not ratchet past the budget')
  }
  const elapsed = ticks * MIN_REVEAL_FRAME_MS
  assert.ok(
    elapsed <= MAX_REVEAL_DURATION_MS + MIN_REVEAL_FRAME_MS,
    `5000 chars took ${elapsed}ms, expected <= ${MAX_REVEAL_DURATION_MS}ms (+1 frame)`,
  )
})

test('small backlogs keep the steady reveal pace', () => {
  const step = revealStepFor(30, REVEAL_STEP_CHARS)
  assert.equal(step, REVEAL_STEP_CHARS, 'small backlog must not speed up')
})

test('revealStepFor never decreases while a backlog drains', () => {
  let step = REVEAL_STEP_CHARS
  let previous = step
  for (let remaining = 5000; remaining > 0; remaining -= step) {
    step = revealStepFor(remaining, step)
    assert.ok(step >= previous, 'step must be monotonic non-decreasing')
    previous = step
  }
})
