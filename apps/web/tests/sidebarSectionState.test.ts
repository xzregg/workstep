import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadSidebarSectionState,
  saveSidebarSectionState,
  type SidebarSectionState,
} from '../src/utils/sidebarSectionState'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

test('sidebar section state round-trips per project in browser storage', () => {
  const storage = new MemoryStorage()
  const state: SidebarSectionState = {
    expandedProjectIds: ['local', 'remote'],
    flowsByProject: { local: false, remote: true },
    conversationsByProject: { local: true, remote: false },
  }

  saveSidebarSectionState(state, storage)

  assert.deepEqual(loadSidebarSectionState(storage), state)
})

test('sidebar section state ignores invalid or non-boolean stored values', () => {
  const storage = new MemoryStorage()
  storage.setItem('workstep.sidebar.expanded-sections.v1', JSON.stringify({
    expandedProjectIds: ['kept', 123],
    flowsByProject: { kept: false, ignored: 'false' },
    conversationsByProject: { kept: true, ignored: 1 },
  }))

  assert.deepEqual(loadSidebarSectionState(storage), {
    expandedProjectIds: ['kept'],
    flowsByProject: { kept: false },
    conversationsByProject: { kept: true },
  })

  storage.setItem('workstep.sidebar.expanded-sections.v1', '{broken')
  assert.deepEqual(loadSidebarSectionState(storage), {
    expandedProjectIds: [],
    flowsByProject: {},
    conversationsByProject: {},
  })
})

test('sidebar section state migrates the previous single-project format', () => {
  const storage = new MemoryStorage()
  storage.setItem('workstep.sidebar.expanded-sections.v1', JSON.stringify({
    expandedProjectId: 'legacy',
  }))

  assert.deepEqual(loadSidebarSectionState(storage), {
    expandedProjectIds: ['legacy'],
    flowsByProject: {},
    conversationsByProject: {},
  })
})
