import { Pause, Play, Repeat, RotateCcw } from 'lucide-react'
import type { DemoDef } from '../demo/demos'
import { formatTime } from '../demo/timeline'
import { useDemoTimeline } from '../demo/useDemoTimeline'
import { useI18n } from '../i18n'

interface DemoPlayerProps {
  demo: DemoDef
  autoplay?: boolean
  showControls?: boolean
  loop?: boolean
}

export function DemoPlayer({ demo, autoplay = true, showControls = true, loop = true }: DemoPlayerProps) {
  const { t } = useI18n()
  const timeline = useDemoTimeline({ durationMs: demo.durationMs, autoplay, loop })
  const Scene = demo.Scene

  return (
    <div className="demo-player">
      <div className="demo-window">
        <div className="demo-viewport">
          <Scene time={timeline.time} />
        </div>
      </div>

      {showControls && (
        <div className="player-controls">
          <button
            type="button"
            className="player-btn"
            onClick={timeline.toggle}
            aria-label={timeline.playing ? t('common.pause') : t('common.play')}
          >
            {timeline.playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button
            type="button"
            className="player-btn"
            onClick={timeline.restart}
            aria-label={t('common.restart')}
          >
            <RotateCcw size={14} />
          </button>
          <input
            type="range"
            className="player-seek"
            min={0}
            max={demo.durationMs}
            step={100}
            value={timeline.time}
            onChange={(event) => timeline.seek(Number(event.target.value))}
            aria-label="timeline"
          />
          <span className="player-time">
            {formatTime(timeline.time)} / {formatTime(demo.durationMs)}
          </span>
          {loop && (
            <span className="player-chip" title={t('common.loop')}>
              <Repeat size={13} />
              {t('common.loop')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
