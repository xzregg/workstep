import { useCallback, useEffect, useRef } from 'react'

export interface ScheduleEditorState { dirty: boolean; busy: boolean }

/** Reset the baseline in the same render as the form is filled or saved. */
export function useScheduleDraftState(snapshot: string, revision: number, editing: boolean, busy: boolean,
  onChange?: (state: ScheduleEditorState) => void) {
  const baseline = useRef({ revision, snapshot })
  useEffect(() => {
    if (baseline.current.revision !== revision) baseline.current = { revision, snapshot }
    onChange?.({ dirty: editing && baseline.current.snapshot !== snapshot, busy })
  }, [snapshot, revision, editing, busy, onChange])
  // Server-loaded defaults are not user edits; only update that field's baseline.
  return useCallback((field: string, value: unknown) => {
    const saved = JSON.parse(baseline.current.snapshot)
    baseline.current.snapshot = JSON.stringify({ ...saved, [field]: value })
  }, [])
}
