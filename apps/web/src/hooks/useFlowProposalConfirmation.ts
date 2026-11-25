import { useCallback, useEffect, useRef, useState } from 'react'

/** A card becomes applied only after the existing overwrite dialog accepts it. */
export function useFlowProposalConfirmation(scope: string) {
  const [steps, setSteps] = useState<any>(null)
  const pending = useRef<{ apply: () => unknown; resolve: (accepted: boolean) => void; reject: (error: unknown) => void } | null>(null)
  const cancel = useCallback(() => {
    pending.current?.resolve(false)
    pending.current = null
    setSteps(null)
  }, [])
  useEffect(() => cancel, [scope, cancel])
  const request = useCallback((next: any, apply: () => unknown) => {
    cancel()
    setSteps(next)
    return new Promise<boolean>((resolve, reject) => { pending.current = { apply, resolve, reject } })
  }, [cancel])
  const confirm = useCallback(async () => {
    const action = pending.current
    pending.current = null
    setSteps(null)
    if (!action) return
    try { action.resolve(await action.apply() !== false) } catch (error) { action.reject(error) }
  }, [])
  return { steps, request, confirm, cancel }
}
