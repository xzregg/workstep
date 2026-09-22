import type { ComponentType } from 'react'
import { CanvasScene } from '../scenes/CanvasScene'
import { ParallelScene } from '../scenes/ParallelScene'
import { StreamScene } from '../scenes/StreamScene'

export interface DemoDef {
  id: 'canvas' | 'stream' | 'parallel'
  Scene: ComponentType<{ time: number }>
  durationMs: number
}

export const DEMOS: DemoDef[] = [
  { id: 'canvas', Scene: CanvasScene, durationMs: 9000 },
  { id: 'stream', Scene: StreamScene, durationMs: 10000 },
  { id: 'parallel', Scene: ParallelScene, durationMs: 8000 },
]
