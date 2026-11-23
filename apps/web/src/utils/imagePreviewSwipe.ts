export function imagePreviewSwipeDirection(deltaX: number, deltaY: number): -1 | 0 | 1 {
  if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= 1.25 * Math.abs(deltaY)) return 0
  return deltaX < 0 ? 1 : -1
}
