import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { useSidebarActivity } from '../src/hooks/useSidebarActivity'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { useProjectStore } from '../src/stores/projectStore'
import { useSidebarActivityStore } from '../src/stores/sidebarActivityStore'
import { useTaskStore } from '../src/stores/taskStore'
import {
  loadSidebarActivityReadState,
  saveSidebarActivityReadState,
} from '../src/utils/sidebarActivityState'

function SidebarActivityProbe() {
  useSidebarActivity('session-1')
  return null
}

function FailedSessionProbe() {
  const { failedChatSessions, projectHasFailedSession } = useSidebarActivity(null)
  return (
    <output>
      {`${failedChatSessions['session-1'] ? 'failed' : 'read'}|${
        projectHasFailedSession('project-1') ? 'project-failed' : 'project-read'}`}
    </output>
  )
}

function FailedWorkflowProbe() {
  const { failedWorkflows } = useSidebarActivity(null)
  return <output>{failedWorkflows['workflow-1'] ? 'failed' : 'read'}</output>
}

function ProjectProbe() {
  const { markProjectRead, projectHasFailure } = useSidebarActivity(null)
  return (
    <>
      <output>{projectHasFailure('project-1') ? 'failed' : 'read'}</output>
      <button type="button" onClick={() => markProjectRead('project-1')}>ack</button>
    </>
  )
}

const FAILED_PROJECT = {
  id: 'project-1',
  name: '测试项目',
  path: '/tmp/project',
  steps: {},
  workflows: [{ id: 'workflow-1', name: '流程', is_default: true, failed: true }],
}

function seedProjectState() {
  useProjectStore.setState({
    projects: [FAILED_PROJECT] as never,
    activeProject: null,
    activeWorkflowId: null,
    fetchProjects: async () => {},
  })
  useTaskStore.setState({ tasks: [] })
  useChatListStore.setState({ sessionsByProject: {}, fetchSessions: async () => {} })
  useChatSessionStore.setState({ sessions: {} } as never)
  useSidebarActivityStore.setState({
    completedWorkflows: {},
    completedSessions: {},
    readFailedWorkflows: {},
    readFailedSessions: {},
    readFailedProjects: {},
  })
}

function setupDom(url = 'http://localhost/chat') {
  const window = new Window({ url })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => window.clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return window
}

test('sidebar activity subscribes to live message status without an unstable snapshot', async () => {
  const window = new Window({ url: 'http://localhost/chat' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => window.clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  useProjectStore.setState({
    projects: [],
    activeProject: null,
    activeWorkflowId: null,
    fetchProjects: async () => {},
  })
  useTaskStore.setState({ tasks: [] })
  useChatListStore.setState({ sessionsByProject: {}, fetchSessions: async () => {} })
  useChatSessionStore.setState({
    sessions: {
      'session-1': {
        messages: [{ id: 'message-1', role: 'assistant', content: '', status: 'running' }],
        running: true,
      },
    },
  } as never)
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat?session=session-1']}>
          <SidebarActivityProbe />
        </MemoryRouter>,
      )
    })
    assert.equal(container.childElementCount, 0)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

function seedFailedSession() {
  useProjectStore.setState({
    projects: [],
    activeProject: null,
    activeWorkflowId: null,
    fetchProjects: async () => {},
  })
  useTaskStore.setState({ tasks: [] })
  useChatListStore.setState({
    sessionsByProject: {
      'project-1': [{ id: 'session-1', project_id: 'project-1', running: false }] as never,
    },
    fetchSessions: async () => {},
  } as never)
  useChatSessionStore.setState({
    sessions: {
      'session-1': {
        messages: [{ id: 'message-1', role: 'assistant', content: '', status: 'error' }],
        running: false,
      },
    },
  } as never)
  useSidebarActivityStore.setState({
    completedSessions: {},
    readFailedSessions: {},
  })
}

test('opening a failed chat session clears its red unread indicator', async () => {
  const window = setupDom()
  seedFailedSession()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat']}>
          <FailedSessionProbe />
        </MemoryRouter>,
      )
    })
    // The failure also rolls up onto its project.
    assert.equal(container.textContent, 'failed|project-failed')

    await act(async () => {
      useSidebarActivityStore.getState().markSessionRead('session-1')
    })
    assert.equal(container.textContent, 'read|project-read')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('a chat session failure lights up again when the next turn fails', async () => {
  const window = setupDom()
  seedFailedSession()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat']}>
          <FailedSessionProbe />
        </MemoryRouter>,
      )
    })
    await act(async () => {
      useSidebarActivityStore.getState().markSessionRead('session-1')
    })
    assert.equal(container.textContent, 'read|project-read')

    // Retry: the new turn supersedes the acknowledged failure.
    await act(async () => {
      useChatSessionStore.setState({
        sessions: {
          'session-1': {
            messages: [{ id: 'message-2', role: 'assistant', content: '', status: 'running' }],
            running: true,
          },
        },
      } as never)
    })
    assert.equal(container.textContent, 'read|project-read')

    // The retry fails too — the indicator must come back.
    await act(async () => {
      useChatSessionStore.setState({
        sessions: {
          'session-1': {
            messages: [{ id: 'message-2', role: 'assistant', content: '', status: 'error' }],
            running: false,
          },
        },
      } as never)
    })
    assert.equal(container.textContent, 'failed|project-failed')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('opening a failed workflow clears its red unread indicator', async () => {
  const window = setupDom('http://localhost/tasks')
  useProjectStore.setState({
    projects: [{
      id: 'project-1',
      name: '项目',
      path: '/tmp/project',
      steps: {},
      workflows: [{ id: 'workflow-1', name: '流程', is_default: true, failed: true }],
    }] as never,
    activeProject: null,
    activeWorkflowId: null,
    fetchProjects: async () => {},
  })
  useTaskStore.setState({ tasks: [] })
  useChatListStore.setState({ sessionsByProject: {}, fetchSessions: async () => {} })
  useChatSessionStore.setState({ sessions: {} } as never)
  useSidebarActivityStore.setState({ completedWorkflows: {}, readFailedWorkflows: {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/tasks']}>
          <FailedWorkflowProbe />
        </MemoryRouter>,
      )
    })
    assert.equal(container.textContent, 'failed')

    await act(async () => {
      useSidebarActivityStore.getState().markWorkflowRead('workflow-1')
    })
    assert.equal(container.textContent, 'read')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('acknowledging a project keeps its roll-up dark for sessions loaded later', async () => {
  const window = setupDom('http://localhost/tasks')
  seedProjectState()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/tasks']}>
          <ProjectProbe />
        </MemoryRouter>,
      )
    })
    assert.equal(container.textContent, 'failedack')

    // Clicking the project acknowledges it, including children not loaded yet.
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(container.textContent, 'readack')

    // The project's chat sessions only arrive after it becomes active.
    await act(async () => {
      useChatListStore.setState({
        sessionsByProject: {
          'project-1': [
            { id: 'session-1', project_id: 'project-1', running: false, last_message_status: 'error' },
          ] as never,
        },
      } as never)
    })
    assert.equal(container.textContent, 'readack')
    assert.equal(useSidebarActivityStore.getState().readFailedSessions['session-1'], undefined)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('a project roll-up lights up again when a later session turn fails', async () => {
  const window = setupDom('http://localhost/chat')
  seedProjectState()
  useChatListStore.setState({
    sessionsByProject: {
      'project-1': [{ id: 'session-1', project_id: 'project-1', running: false }] as never,
    },
    fetchSessions: async () => {},
  } as never)
  useChatSessionStore.setState({
    sessions: {
      'session-1': {
        messages: [{ id: 'message-1', role: 'assistant', content: '', status: 'error' }],
        running: false,
      },
    },
  } as never)
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat']}>
          <ProjectProbe />
        </MemoryRouter>,
      )
    })
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(container.textContent, 'readack')

    // A retried turn is a new outcome the user has not seen yet.
    await act(async () => {
      useChatSessionStore.setState({
        sessions: {
          'session-1': {
            messages: [{ id: 'message-2', role: 'assistant', content: '', status: 'running' }],
            running: true,
          },
        },
      } as never)
    })
    await act(async () => {
      useChatSessionStore.setState({
        sessions: {
          'session-1': {
            messages: [{ id: 'message-2', role: 'assistant', content: '', status: 'error' }],
            running: false,
          },
        },
      } as never)
    })
    assert.equal(container.textContent, 'failedack')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('a persisted acknowledgement keeps the roll-up dark after a reload', async () => {
  const window = setupDom('http://localhost/tasks')
  saveSidebarActivityReadState({
    readFailedWorkflows: { 'workflow-1': true },
    readFailedSessions: {},
    readFailedProjects: { 'project-1': true },
  }, window.localStorage)
  seedProjectState()
  // Stand in for the store's initial state on a fresh page load.
  useSidebarActivityStore.setState(loadSidebarActivityReadState(window.localStorage))
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/tasks']}>
          <ProjectProbe />
        </MemoryRouter>,
      )
    })
    assert.equal(container.textContent, 'readack')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('a resolved failure drops its persisted marker so the next failure lights up', async () => {
  const window = setupDom('http://localhost/tasks')
  seedProjectState()
  useSidebarActivityStore.setState({ readFailedWorkflows: { 'workflow-1': true } })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  const setWorkflowFailed = (failed: boolean) => {
    useProjectStore.setState({
      projects: [{
        ...FAILED_PROJECT,
        workflows: [{ id: 'workflow-1', name: '流程', is_default: true, failed }],
      }] as never,
    })
  }

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/tasks']}>
          <FailedWorkflowProbe />
        </MemoryRouter>,
      )
    })
    assert.equal(container.textContent, 'read')

    // The failure is resolved: the stale marker must not survive it.
    await act(async () => { setWorkflowFailed(false) })
    assert.deepEqual(useSidebarActivityStore.getState().readFailedWorkflows, {})
    assert.equal(container.textContent, 'read')

    // A brand-new failure is not silenced by the old acknowledgement.
    await act(async () => { setWorkflowFailed(true) })
    assert.equal(container.textContent, 'failed')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
