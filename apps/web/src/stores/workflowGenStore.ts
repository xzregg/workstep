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
} from './assistantStore'

export type GenChatEvent = AssistantChatEvent
export type GenChatMessage = AssistantChatMessage
export type GenProposalCard = AssistantProposalCard
export type GenSessionState = AssistantSessionState

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
        summary: String(item.summary || ''),
        steps: item.steps,
        nodeCount: Number(item.nodeCount || 0),
        autoApply: item.autoApply === true,
      }))
  },
  rejectionMessageExtractor: (data) =>
    String(data.message || zhCNT('aiFlow.proposalRejected')),
})
