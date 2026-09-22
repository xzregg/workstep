export interface TaskCreationErrors {
  titleError: string
  panelError: string
}

export function resolveTaskCreationErrors(
  titleError: string,
  createError: string,
): TaskCreationErrors
