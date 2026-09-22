export type ForkContextMode = 'native' | 'smart' | 'full' | 'none'

/**
 * Whether switching endpoints on an existing conversation needs a context
 * handoff. An engine change always does; staying on the same engine but
 * changing the provider binding does too (engine sessions are endpoint-bound,
 * including clearing back to the engine default).
 */
export function requiresEngineHandoff(
  sourceEngine: string,
  targetEngine: string,
  messageCount: number,
  sourceProvider = '',
  targetProvider = '',
  handoffAlreadyConfirmed = false,
): boolean {
  if (messageCount <= 0 || !sourceEngine || handoffAlreadyConfirmed) return false
  if (sourceEngine !== targetEngine) return true
  return sourceProvider !== targetProvider
}

export function resolveForkContextMode(
  sourceEngine: string,
  targetEngine: string,
  targetSupportsNativeFork: boolean,
  forkAtTail = true,
  sourceProvider = '',
  targetProvider = '',
): ForkContextMode {
  const providerMatches = sourceProvider === targetProvider
  return sourceEngine === targetEngine
    && providerMatches
    && targetSupportsNativeFork
    && forkAtTail
    ? 'native'
    : 'smart'
}
