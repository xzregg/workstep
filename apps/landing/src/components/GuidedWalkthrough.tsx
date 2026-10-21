import { Check, Pause, Play, RotateCcw } from 'lucide-react'
import type { CSSProperties } from 'react'
import recording from '../assets/workstep-tutorial.webm'
import poster from '../assets/workstep-tutorial-poster.png'
import { getWalkthroughFrame, WALKTHROUGH_CHAPTERS } from '../demo/walkthrough'
import { useRecordedWalkthrough } from '../demo/useRecordedWalkthrough'
import { useI18n } from '../i18n'
import './GuidedWalkthrough.css'

function formatTime(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

export function GuidedWalkthrough() {
  const { t } = useI18n()
  const player = useRecordedWalkthrough()
  const frame = getWalkthroughFrame(player.time)
  const key = `walkthrough.${frame.definition.id}`
  const chapterNumber = String(frame.chapter + 1).padStart(2, '0')

  return (
    <section className="guided-walkthrough" id="demos" aria-label={t('walkthrough.label')}>
      <div className="walkthrough-intro"><span>{t('walkthrough.eyebrow')}</span><span>{t('walkthrough.duration')}</span></div>
      <div className="walkthrough-player">
        <div className="walkthrough-stage">
          <div className="walkthrough-viewport" ref={player.stageRef}>
            <div className="walkthrough-camera" ref={player.cameraRef}>
              <video ref={player.videoRef} poster={poster} preload="metadata" playsInline muted aria-label={t('walkthrough.videoLabel')}>
                <source src={recording} type="video/webm" />
              </video>
            </div>
            <div className="walkthrough-scrim" aria-hidden="true" />
          </div>
          <aside className="walkthrough-guide" key={frame.chapter} aria-label={t('walkthrough.stepsLabel')}>
            <div className="walkthrough-kicker">{chapterNumber} · {t(`${key}.label`)}</div>
            <h2>{t(`${key}.titleA`)}<br />{t(`${key}.titleB`)}</h2>
            <ol className="walkthrough-list">
              {frame.definition.revealAt.map((_, index) => (
                <li key={index} className={`walkthrough-item${index < frame.revealed ? ' is-visible' : ''}${index === frame.revealed - 1 ? ' is-current' : ''}`} aria-hidden={index >= frame.revealed}>
                  <span className="walkthrough-check" aria-hidden="true"><Check size={12} /></span>
                  <span>{t(`${key}.step${index + 1}`)}</span>
                </li>
              ))}
            </ol>
          </aside>
          <span className="walkthrough-scene-label">{t('walkthrough.recorded')} · {t(`${key}.label`)}</span>
          <span className="walkthrough-counter" aria-hidden="true">{chapterNumber} / 04</span>
          {player.failed && <div className="walkthrough-error"><p>{t('walkthrough.loadError')}</p><button type="button" onClick={player.retry}>{t('walkthrough.retry')}</button></div>}
        </div>
        <nav className="walkthrough-chapters" aria-label={t('walkthrough.chaptersLabel')}>
          {WALKTHROUGH_CHAPTERS.map((chapter, index) => <button type="button" key={chapter.id} className="walkthrough-chapter" aria-current={frame.chapter === index ? 'step' : undefined} onClick={() => player.seek(chapter.at)}>
            <span className="walkthrough-chapter-index">{String(index + 1).padStart(2, '0')}</span><span>{t(`walkthrough.${chapter.id}.label`)}</span><span className="walkthrough-chapter-time">{formatTime(chapter.at)}</span>
          </button>)}
        </nav>
        <div className="walkthrough-controls">
          <button type="button" className="walkthrough-button walkthrough-play" onClick={player.toggle} aria-label={t(player.playing ? 'walkthrough.pause' : 'walkthrough.play')} disabled={player.failed}>{player.playing ? <Pause size={16} /> : <Play size={16} />}</button>
          <button type="button" className="walkthrough-button" onClick={player.restart} aria-label={t('walkthrough.restart')} disabled={player.failed}><RotateCcw size={16} /></button>
          <input type="range" className="walkthrough-seek" min={0} max={player.duration} step={.01} value={player.time} onChange={event => player.seek(Number(event.target.value))} style={{ '--walkthrough-progress': `${player.time / player.duration * 100}%` } as CSSProperties} aria-label={t('walkthrough.progress')} aria-valuetext={`${formatTime(player.time)} · ${t(`${key}.label`)}`} disabled={player.failed} />
          <span className="walkthrough-time">{formatTime(player.time)} / {formatTime(Math.ceil(player.duration))}</span>
          <span className="walkthrough-control-note">{t('walkthrough.motionNote')}</span>
        </div>
      </div>
      <p className="walkthrough-caption">{t('walkthrough.disclaimer')}</p>
    </section>
  )
}
