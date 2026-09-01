export type ForkContextMode = 'native' | 'smart' | 'full' | 'none'

export function requiresEngineHandoff(
  sourceEngine: string,
  targetEngine: string,
  messageCount: number,
): boolean {
  return messageCount > 0 && Boolean(sourceEngine) && sourceEngine !== targetEngine
}

export function resolveForkContextMode(
  sourceEngine: string,
  targetEngine: string,
  targetSupportsNativeFork: boolean,
  forkAtTail = true,
): ForkContextMode {
  return sourceEngine === targetEngine && targetSupportsNativeFork && forkAtTail
    ? 'native'
    : 'smart'
}
