import { Check, Loader2, Play, Table } from 'lucide-react'
import { useI18n } from '../i18n'
import { arrive } from './utils'

interface Lane {
  label: string
  color: string
  card?: { title: string; desc: string; tokens: string }
}

export function ParallelScene({ time }: { time: number }) {
  const { t } = useI18n()
  const testDone = time >= 6200
  const deployCard = time >= 7000

  const lanes: Lane[] = [
    { label: t('scene.board.laneReq'), color: '#0071e3', card: { title: t('scene.board.card1'), desc: t('scene.board.desc1'), tokens: '18.2k' } },
    { label: t('scene.board.laneDesign'), color: '#7c3aed', card: { title: t('scene.board.card2'), desc: t('scene.board.desc2'), tokens: '9.6k' } },
    { label: t('scene.board.laneFrontend'), color: '#059669', card: { title: t('scene.board.card3'), desc: t('scene.board.desc3'), tokens: '24.1k' } },
    { label: t('scene.board.laneBackend'), color: '#d97706', card: { title: t('scene.board.card4'), desc: t('scene.board.desc4'), tokens: '21.4k' } },
    { label: t('scene.board.laneTest'), color: '#dc2626', card: { title: t('scene.board.card5'), desc: t('scene.board.desc5'), tokens: '12.8k' } },
    { label: t('scene.board.laneDeploy'), color: '#16a34a', card: deployCard ? { title: t('scene.board.card6'), desc: t('scene.board.desc6'), tokens: '4.2k' } : undefined },
  ]

  const statusFor = (index: number) => {
    if (index === 0 || index === 1) return 'done'
    if (index === 2 || index === 3) return 'running'
    if (index === 4) return testDone ? 'done' : 'reviewing'
    if (index === 5) return deployCard ? 'done' : 'ready'
    return 'ready'
  }

  const statusText = (status: string) =>
    status === 'running'
      ? t('scene.board.running')
      : status === 'done'
        ? t('scene.board.done')
        : status === 'reviewing'
          ? t('scene.board.reviewing')
          : t('scene.board.ready')

  return (
    <div className="scene-body scene-board">
      <div className="app-topbar board-topbar">
        <span className="tb-btn">
          <Table size={13} />
          {t('scene.board.editStages')}
        </span>
        <span className="tb-btn tb-primary">
          +
          {t('scene.board.newTask')}
        </span>
        <span className="tb-flow">
          <span className="tb-flow-dot" />
          {t('scene.board.workflowName')}
        </span>
        <span className="tb-id">{t('scene.board.id')}</span>
        <span className="tb-spacer" />
        <span className="tb-btn">{t('scene.board.share')}</span>
        <span className="tb-btn">{t('scene.board.schedule')}</span>
        <span className="tb-btn">{t('scene.board.memory')}</span>
        <span className="tb-btn">{t('scene.board.archive')}</span>
        <span className="tb-btn">{t('scene.board.openDir')} ▾</span>
      </div>

      <div className="board-lanes board-lanes-full">
        {lanes.map((lane, index) => {
          const status = statusFor(index)
          const isRunning = status === 'running'
          const isReviewing = status === 'reviewing'
          return (
            <div key={lane.label} className={`board-lane${isRunning || isReviewing ? ' is-active-lane' : ''}`}>
              <div className="lane-head">
                <span className="lane-dot" style={{ background: lane.color }} />
                <span className="lane-name">{lane.label}</span>
                <span className="lane-count">{lane.card ? 1 : 0}</span>
              </div>
              <div className="lane-body">
                {lane.card ? (
                  <div className={`board-card${isRunning ? ' is-running' : ''}`} style={{ opacity: arrive(time, 200 + index * 140, 420) }}>
                    <div className="card-title-row">
                      <span className="card-title">{lane.card.title}</span>
                      <span className={`status-badge sb-${status}`}>
                        {(isRunning || isReviewing) && <Loader2 size={10} className="spin" />}
                        {statusText(status)}
                      </span>
                    </div>
                    <div className="card-desc">{lane.card.desc}</div>
                    <div className="card-footer">
                      <span className="card-start">
                        <Play size={11} />
                      </span>
                      <span className="card-tokens">{lane.card.tokens} tokens</span>
                      {isRunning && <span className="card-duration">{t('scene.board.duration')}</span>}
                    </div>
                    {isRunning && (
                      <div className="card-progress">
                        <span className="card-progress-fill" style={{ animationDelay: `${index * 0.3}s` }} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="lane-empty" />
                )}
              </div>
            </div>
          )
        })}
      </div>

      {time >= 7500 && (
        <div className="board-done">
          <Check size={14} />
          {t('scene.board.allDone')}
        </div>
      )}
    </div>
  )
}
