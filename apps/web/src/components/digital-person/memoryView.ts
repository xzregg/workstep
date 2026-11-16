import type { MemoryViewItem } from '../../api/digitalPerson'

export const memoryTitle = (item:MemoryViewItem) => item.summary.split(/[。！？\n]/)[0].replace(/\s+/g,' ').slice(0,64)
