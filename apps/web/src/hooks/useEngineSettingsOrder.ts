import { useMemo, useState } from 'react'
import type { EngineInfo } from '../api/client'

// Only a new visit partitions cards. Catalog updates keep existing positions;
// newly discovered IDs append until the next visit.
export function useEngineSettingsOrder(engines: EngineInfo[], hidden: boolean, loading: boolean) {
  const [snapshot, setSnapshot] = useState<{ hidden: boolean; order: string[] | null }>({ hidden, order: null })
  let order = hidden || snapshot.hidden !== hidden ? null : snapshot.order
  if (!hidden) {
    if (order === null) {
      if (!loading || engines.length > 0) order = [
        ...engines.filter(engine => engine.enabled !== false),
        ...engines.filter(engine => engine.enabled === false),
      ].map(engine => engine.id)
    } else {
      const known = new Set(order)
      const added = engines.filter(engine => !known.has(engine.id))
      if (added.length) order = [...order, ...added.map(engine => engine.id)]
    }
  }
  // Adjust the visit snapshot before rendering children so entry never paints
  // the previous visit's order, including when the initial catalog arrives later.
  if (snapshot.hidden !== hidden || snapshot.order !== order) setSnapshot({ hidden, order })

  return useMemo(() => {
    if (order === null) return engines
    const byId = new Map(engines.map(engine => [engine.id, engine]))
    const known = new Set(order)
    return [
      ...order.flatMap(id => byId.has(id) ? [byId.get(id)!] : []),
      ...engines.filter(engine => !known.has(engine.id)),
    ]
  }, [engines, order])
}
