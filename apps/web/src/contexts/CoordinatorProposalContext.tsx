import { createContext, useContext } from 'react'
import type { ActionProposal } from '../api/client'

export interface CoordinatorProposalActions {
  canApply: (proposal: ActionProposal) => boolean
  confirm: (id: string, idempotencyKey: string, overwrite: boolean) => Promise<ActionProposal>
  cancel: (id: string) => Promise<ActionProposal>
  latest: (id: string) => Promise<ActionProposal | undefined>
}

export const CoordinatorProposalContext = createContext<CoordinatorProposalActions | undefined>(undefined)
export const useCoordinatorProposalActions = () => useContext(CoordinatorProposalContext)
