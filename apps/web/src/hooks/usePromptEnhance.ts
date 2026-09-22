/**
 * usePromptEnhance — shared prompt-enhancement pill state for chat inputs.
 *
 * Binds the framework-free PromptEnhancer to a component via
 * useSyncExternalStore, so ChatPage / AI flow chat / AI task create / task
 * detail conversation all share one implementation (and the same daemon
 * enhance endpoint) instead of duplicating the pill logic.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'

import { chatSessionApi } from '../api/client'
import type { ChatInputEnhance } from '../components/ChatInput'
import { PromptEnhancer } from '../utils/promptEnhance'

export interface UsePromptEnhanceOptions {
  /** Active project id; undefined hides the pill and disables enhance. */
  projectId?: string
  /** Read the current draft text. */
  getDraft: () => string
  /** Write the enhanced / reverted draft back to the input. */
  setDraft: (value: string) => void
  /** Surface a failure message. */
  onError: (message: string) => void
  /** Fallback message for non-Error failures. */
  errorMessage: string
}

export interface UsePromptEnhanceResult {
  /** Pass to ChatInput as the `enhance` prop. */
  enhance: ChatInputEnhance | undefined
  /** Wrap the input onChange; exits the enhanced state when the user edits. */
  onInputChange: (value: string) => void
  /** Clear transient state (session switch / message sent). */
  reset: () => void
}

export function usePromptEnhance(options: UsePromptEnhanceOptions): UsePromptEnhanceResult {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [enhancer] = useState(() => new PromptEnhancer({
    projectId: () => optionsRef.current.projectId,
    getDraft: () => optionsRef.current.getDraft(),
    setDraft: (value) => optionsRef.current.setDraft(value),
    onError: (message) => optionsRef.current.onError(message),
    errorMessage: () => optionsRef.current.errorMessage,
    enhanceRequest: (projectId, prompt) => chatSessionApi.enhancePrompt(projectId, prompt),
  }))
  const phase = useSyncExternalStore(
    useCallback((listener: () => void) => enhancer.subscribe(listener), [enhancer]),
    useCallback(() => enhancer.getPhase(), [enhancer]),
  )
  const onInputChange = useCallback(
    (value: string) => enhancer.inputChanged(value),
    [enhancer],
  )
  const reset = useCallback(() => enhancer.reset(), [enhancer])
  const enhance: ChatInputEnhance | undefined = options.projectId ? {
    enhancing: phase === 'enhancing',
    enhanced: phase === 'enhanced',
    onEnhance: () => void enhancer.enhance(),
    onRevert: () => enhancer.revert(),
  } : undefined
  return { enhance, onInputChange, reset }
}
