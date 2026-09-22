/** Capture JSON canvas data by value so later editor mutations cannot alter it. */
export function cloneCanvasSteps<T>(steps: T): T {
  return JSON.parse(JSON.stringify(steps)) as T
}
