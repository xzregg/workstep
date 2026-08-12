export function resolveTaskCreationErrors(titleError, createError) {
  return {
    titleError,
    panelError: createError === titleError ? '' : createError,
  }
}
