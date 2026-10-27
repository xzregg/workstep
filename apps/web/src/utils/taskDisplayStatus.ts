/** Keep task lists and detail headers consistent about review waits. */
export function taskDisplayStatus(
  status: string | null | undefined,
  steps: ReadonlyArray<{ status?: string | null }>,
  completed: boolean,
) {
  const stepStatus = ['reviewing', 'awaiting_review', 'retrying', 'rejected']
    .find((candidate) => steps.some((step) => step.status === candidate))
  return { stepStatus, displayStatus: completed ? 'done' : stepStatus || status || 'ready' }
}
