const PROCESS_TRACE_RIGHT_GAP = 24

export function processTracePanelAvailableWidth(
  rightBoundary: number,
  anchorLeft: number,
): number {
  return Math.max(0, Math.floor(rightBoundary - anchorLeft - PROCESS_TRACE_RIGHT_GAP))
}
