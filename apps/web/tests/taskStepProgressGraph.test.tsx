import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskStepProgressGraph, {
  type ProgressGraphStepProgress,
} from '../src/components/TaskStepProgressGraph'
import { deriveStepRounds } from '../src/components/taskStepProgressLayout'
import { I18nProvider } from '../src/i18n'

function installDom() {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    DOMRect: window.DOMRect,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return window
}

const steps = [
  { key: 'req', label: '需求', color: '#888' },
  {
    key: 'research-a',
    label: '市场调研',
    color: '#4C9AFF',
    dependsOn: ['req'],
  },
  {
    key: 'research-b',
    label: '用户研究',
    color: '#AF52DE',
    dependsOn: ['req'],
  },
  {
    key: 'outline',
    label: '大纲设计',
    color: '#5E5CE6',
    dependsOn: ['research-a', 'research-b'],
  },
  {
    key: 'review',
    label: '审核定稿',
    color: '#F5A623',
    dependsOn: ['outline'],
    reworkDependsOn: ['outline'],
  },
]

const progress: ProgressGraphStepProgress[] = [
  { step_key: 'req', status: 'passed', visualState: 'completed', started_at: '2026-09-18T01:00:00Z', ended_at: '2026-09-18T01:10:00Z' },
  { step_key: 'research-a', status: 'running', visualState: 'current', started_at: '2026-09-18T01:10:00Z', ended_at: null, artifact_round: 4 },
  { step_key: 'research-b', status: 'pending', visualState: 'pending', started_at: null, ended_at: null },
  { step_key: 'outline', status: 'pending', visualState: 'pending', started_at: null, ended_at: null },
  { step_key: 'review', status: 'pending', visualState: 'pending', started_at: null, ended_at: null },
]

test('step progress graph lays out parallel branches and preserves connectable nodes', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStepProgressGraph
            taskStatus="running"
            runRound={4}
            steps={steps}
            stepProgress={progress}
            artifacts={[]}
            selectedStep={1}
            durationNowMs={Date.now()}
            onStepClick={() => {}}
          />
        </I18nProvider>,
      )
    })

    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-step-key]'))
    assert.equal(nodes.length, steps.length)
    assert.equal(nodes[0].style.left, '28px')
    assert.equal(nodes[1].style.left, nodes[2].style.left)
    assert.ok(Number.parseFloat(nodes[3].style.left) > Number.parseFloat(nodes[1].style.left))
    const currentCard = container.querySelector('.task-step-progress-card.is-current')
    assert.match(currentCard?.textContent || '', /当前/)
    assert.match(currentCard?.textContent || '', /进行中/)
    assert.match(currentCard?.textContent || '', /4 轮/)
    assert.equal(
      container.querySelectorAll('[data-testid="task-step-progress-current-tag"]').length,
      1,
    )
    assert.equal(
      currentCard?.querySelectorAll('.task-step-progress-round-tag').length,
      1,
    )

    const edgePaths = Array.from(container.querySelectorAll<SVGPathElement>('.task-step-progress-edge'))
    assert.equal(edgePaths.length, 5)
    assert.ok(edgePaths.every((path) => (path.getAttribute('d') || '').length > 0))
    assert.ok(container.querySelector('.task-step-progress-edges')?.closest('.task-step-progress-grid'))
    assert.ok(container.querySelector('.task-step-progress-edge.is-dashed.is-rework'))
    assert.ok(container.querySelector('.task-step-progress-port.is-dashed.is-rework'))
    assert.match(container.querySelector('.task-step-progress-focus')?.textContent || '', /当前步骤：市场调研/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('step progress graph keeps the current-step tag on the active step after selection changes', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStepProgressGraph
            taskStatus="running"
            runRound={4}
            steps={steps}
            stepProgress={progress}
            artifacts={[]}
            selectedStep={4}
            durationNowMs={Date.now()}
            onStepClick={() => {}}
          />
        </I18nProvider>,
      )
    })

    assert.match(
      container.querySelector('[data-testid="task-step-progress-current-step"]')?.textContent || '',
      /当前步骤：市场调研/,
    )
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('step progress graph clicks cards but not after a card drag', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const clicks: number[] = []
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStepProgressGraph
            taskStatus="running"
            runRound={1}
            steps={steps}
            stepProgress={progress}
            artifacts={[]}
            selectedStep={0}
            durationNowMs={Date.now()}
            onStepClick={(index) => clicks.push(index)}
          />
        </I18nProvider>,
      )
    })

    const card = container.querySelectorAll<HTMLButtonElement>('.task-step-progress-card')[1]
    await act(async () => {
      card.click()
    })
    assert.deepEqual(clicks, [1])

    await act(async () => {
      card.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }))
      card.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 42, button: 0 }))
      card.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 42, button: 0 }))
      card.click()
    })
    assert.deepEqual(clicks, [1])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('step progress graph ignores wheel zoom and centers the selected step', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStepProgressGraph
            taskStatus="running"
            runRound={1}
            steps={steps}
            stepProgress={progress}
            artifacts={[]}
            selectedStep={3}
            durationNowMs={Date.now()}
            onStepClick={() => {}}
          />
        </I18nProvider>,
      )
    })

    const surface = container.querySelector<HTMLElement>('.task-step-progress-surface')!
    const grid = container.querySelector<HTMLElement>('.task-step-progress-grid')!
    assert.match(grid.style.transform, /scale\(1\)/)

    await act(async () => {
      surface.dispatchEvent(new window.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 60,
        deltaY: -120,
      }))
    })
    assert.match(grid.style.transform, /scale\(1\)/)

    const selected = container.querySelectorAll<HTMLElement>('[data-step-key]')[3]
    assert.ok(Number.parseFloat(selected.style.left) > 28)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('deriveStepRounds uses artifact rounds and restart offsets', () => {
  const rounds = deriveStepRounds(
    5,
    'research-b',
    steps,
    [
      { visualState: 'completed', artifact_round: 3 },
      { visualState: 'completed', artifact_round: 0 },
      { visualState: 'pending', artifact_round: 0 },
      { visualState: 'pending', artifact_round: 0 },
      { visualState: 'pending', artifact_round: 0 },
    ],
    [{ step_key: 'research-b', round: 2 } as any],
  )
  assert.deepEqual(rounds, [3, 4, 2, 5, 5])
})
