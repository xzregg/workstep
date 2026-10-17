import { useEffect, useRef } from 'react'

export type SkinAction = { run: (args?: Record<string, unknown>) => unknown; enabled?: () => boolean }
export interface SkinContext { projectId?: string; sessionId?: string; taskId?: string; readOnly?: boolean }
const actions = new Map<string, { owner: symbol; action: SkinAction }[]>()
const contexts: { owner: symbol; value: SkinContext }[] = []
const listeners = new Set<() => void>()
let revision = 0
export const skinActionRevision = () => revision
export const subscribeSkinActions = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function changed() { revision++; listeners.forEach(listener => listener()) }
export const skinContext = (): SkinContext => contexts.at(-1)?.value ?? {}
export function registerSkinActions(entries: Record<string, SkinAction>, context?: SkinContext) {
  const owner = Symbol()
  for (const [id, action] of Object.entries(entries)) actions.set(id, [...(actions.get(id) ?? []), { owner, action }])
  if (context) contexts.push({ owner, value: context })
  changed()
  return () => {
    for (const [id, stack] of actions) {
      const next = stack.filter(item => item.owner !== owner)
      if (next.length) actions.set(id, next); else actions.delete(id)
    }
    const index = contexts.findIndex(item => item.owner === owner)
    if (index >= 0) contexts.splice(index, 1)
    changed()
  }
}
export const skinActionEnabled = (id: string) => {
  const action = actions.get(id)?.at(-1)?.action
  return !!action && (action.enabled?.() ?? true)
}
export async function executeSkinAction(id: string, args?: Record<string, unknown>) {
  const action = actions.get(id)?.at(-1)?.action
  if (!action || !skinActionEnabled(id)) throw new Error('当前上下文不支持此操作')
  return action.run(args)
}
export function useSkinActions(entries: Record<string, SkinAction>, context?: SkinContext) {
  const latest = useRef(entries); latest.current = entries
  const key = Object.keys(entries).sort().join(',')
  const availability = Object.values(entries).map(action => action.enabled?.() ?? true).join(',')
  const hasContext = !!context
  const projectId = context?.projectId, sessionId = context?.sessionId, taskId = context?.taskId, readOnly = context?.readOnly
  useEffect(changed, [availability])
  useEffect(() => registerSkinActions(Object.fromEntries(key.split(',').filter(Boolean).map(id => [id, {
    run: (args?: Record<string, unknown>) => latest.current[id].run(args), enabled: () => latest.current[id].enabled?.() ?? true,
  }])), hasContext ? { projectId, sessionId, taskId, readOnly } : undefined), [key, hasContext, projectId, sessionId, taskId, readOnly])
}
