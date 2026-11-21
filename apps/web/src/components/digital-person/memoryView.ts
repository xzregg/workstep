import type { MemoryViewItem } from '../../api/digitalPerson'

export const memoryTitle = (item:MemoryViewItem) => item.summary.split(/[。！？\n]/)[0].replace(/\s+/g,' ').slice(0,64)

type MemoryEvidence = Pick<MemoryViewItem,'entities'|'sources'>

export function memoryClues(item:MemoryEvidence) {
  return [...item.sources.map(source=>source.id),...item.entities.map(entity=>entity.kind+':'+entity.name)]
}
