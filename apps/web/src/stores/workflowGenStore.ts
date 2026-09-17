/**
 * workflowGenStore — AI flow-design assistant chat store.
 *
 * Implemented as one configured instance of the generic assistant store
 * (`assistantStore.ts`): the only workflow-specific bits are the structured
 * "flow proposal" event wiring. New assistants register their own config
 * instead of copying this file.
 */

import { zhCNT } from '../i18n'
import { CUSTOM } from '../utils/agui.ts'
import {
  createAssistantStore,
  type AssistantChatEvent,
  type AssistantChatMessage,
  type AssistantProposalCard,
  type AssistantSessionState,
  type AssistantStageChange,
} from './assistantStore'

export type GenChatEvent = AssistantChatEvent
export type GenChatMessage = AssistantChatMessage
export type GenProposalCard = AssistantProposalCard
export type GenSessionState = AssistantSessionState

/** Keep the raw incremental patch so a subset of stages can be applied. */
function normalizePatch(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const patch: {
    upsertNodes?: Record<string, unknown>[]
    removeNodeIds?: number[]
    connections?: Record<string, unknown>[]
  } = {}
  if (Array.isArray(record.upsertNodes)) {
    patch.upsertNodes = record.upsertNodes.filter(
      (node): node is Record<string, unknown> => !!node && typeof node === 'object',
    )
  }
  if (Array.isArray(record.removeNodeIds)) {
    patch.removeNodeIds = record.removeNodeIds.filter(
      (id): id is number => typeof id === 'number' && Number.isInteger(id),
    )
  }
  if (Array.isArray(record.connections)) {
    patch.connections = record.connections.filter(
      (conn): conn is Record<string, unknown> => !!conn && typeof conn === 'object',
    )
  }
  return (patch.upsertNodes || patch.removeNodeIds || patch.connections)
    ? patch
    : undefined
}

/** Normalize the backend ``stageChanges`` payload for partial-apply UI. */
function normalizeStageChanges(value: unknown): AssistantStageChange[] | undefined {
  if (!Array.isArray(value)) return undefined
  const changes = value
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'number',
    )
    .map((entry) => ({
      id: Number(entry.id),
      key: String(entry.key || ''),
      title: String(entry.title || ''),
      change: (entry.change === 'added' || entry.change === 'removed'
        ? entry.change
        : 'updated') as AssistantStageChange['change'],
    }))
  return changes.length > 0 ? changes : undefined
}

export const useWorkflowGenStore = createAssistantStore({
  channel: 'flow_gen',
  proposalEvent: CUSTOM.flowProposals,
  rejectionEvent: CUSTOM.flowProposalsRejected,
  proposalRejectedText: () => zhCNT('aiFlow.proposalRejected'),
  generateFailedText: () => zhCNT('aiFlow.generateFailed'),
  proposalExtractor: (data) => {
    const items = data.proposals
    if (!Array.isArray(items)) return []
    return (items as unknown[])
      .filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !!(item as Record<string, unknown>).steps,
      )
      .map((item) => ({
        id: String(item.id || ''),
        title: String(item.title || zhCNT('aiFlow.defaultProposalTitle')),
        workflowName: typeof item.workflowName === 'string'
          ? item.workflowName.trim()
          : undefined,
        summary: String(item.summary || ''),
        steps: item.steps,
        nodeCount: Number(item.nodeCount || 0),
        autoApply: item.autoApply === true,
        stageChanges: normalizeStageChanges(item.stageChanges),
        patch: normalizePatch(item.patch),
      }))
  },
  rejectionMessageExtractor: (data) =>
    String(data.message || zhCNT('aiFlow.proposalRejected')),
})
