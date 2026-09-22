/**
 * Prompt enhancement controller — pure logic shared by every chat input
 * (ChatPage / AI flow chat / AI task create / task detail conversation).
 * The React hook `usePromptEnhance` binds this to a component; this module
 * stays framework-free so the behavior is covered by node:test.
 */

export type PromptEnhancePhase = 'idle' | 'enhancing' | 'enhanced'

export interface PromptEnhancerDeps {
  /** Active project id; empty disables enhance. */
  projectId: () => string | undefined
  /** Read the current draft text. */
  getDraft: () => string
  /** Write the enhanced / reverted draft back to the input. */
  setDraft: (value: string) => void
  /** Surface a failure message to the host. */
  onError: (message: string) => void
  /** Fallback message for non-Error failures. */
  errorMessage: () => string
  /** The actual rewrite request (defaults to the daemon enhance endpoint). */
  enhanceRequest: (projectId: string, prompt: string) => Promise<{ prompt: string }>
}

export class PromptEnhancer {
  private phase: PromptEnhancePhase = 'idle'
  private original = ''
  private enhancedValue = ''
  private readonly listeners = new Set<() => void>()
  private readonly deps: PromptEnhancerDeps

  constructor(deps: PromptEnhancerDeps) {
    this.deps = deps
  }

  getPhase(): PromptEnhancePhase {
    return this.phase
  }

  get enhancing(): boolean {
    return this.phase === 'enhancing'
  }

  get enhanced(): boolean {
    return this.phase === 'enhanced'
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async enhance(): Promise<void> {
    if (this.phase === 'enhancing') return
    const projectId = this.deps.projectId()
    if (!projectId) return
    const draft = this.deps.getDraft().trim()
    if (!draft) return
    this.original = draft
    this.setPhase('enhancing')
    try {
      const result = await this.deps.enhanceRequest(projectId, draft)
      this.enhancedValue = result.prompt
      this.deps.setDraft(result.prompt)
      this.setPhase('enhanced')
    } catch (reason) {
      this.original = ''
      this.enhancedValue = ''
      this.setPhase('idle')
      this.deps.onError(reason instanceof Error ? reason.message : this.deps.errorMessage())
    }
  }

  revert(): void {
    this.deps.setDraft(this.original || this.enhancedValue)
    this.original = ''
    this.enhancedValue = ''
    this.setPhase('idle')
  }

  /** Call on every user input change; exits the enhanced state when edited. */
  inputChanged(value: string): void {
    if (this.phase === 'enhanced' && value !== this.enhancedValue) {
      this.original = ''
      this.enhancedValue = ''
      this.setPhase('idle')
    }
  }

  /** Clear transient state (session switch / message sent). */
  reset(): void {
    this.original = ''
    this.enhancedValue = ''
    this.setPhase('idle')
  }

  private setPhase(phase: PromptEnhancePhase): void {
    if (this.phase === phase) return
    this.phase = phase
    for (const listener of this.listeners) listener()
  }
}
