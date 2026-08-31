export type ForkContextMode = 'native' | 'smart' | 'full' | 'none'

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
