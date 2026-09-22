import { Check, Loader2, Send } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useI18n } from '../i18n'
import { arrive, typewriter } from './utils'

interface StageOutput {
  key: string
  type: string
  doneAt?: number
}

const STAGES: Array<{
  key: string
  color: string
  doneAt?: number
  activeFrom?: number
  outputs?: StageOutput[]
}> = [
  {
    key: 'stage1',
    color: '#0071e3',
    doneAt: 2400,
    outputs: [{ key: 'out1', type: 'md', doneAt: 2400 }],
  },
  {
    key: 'stage2',
    color: '#7c3aed',
    doneAt: 4000,
    outputs: [{ key: 'out2', type: 'md', doneAt: 4000 }],
  },
  {
    key: 'stage3',
    color: '#059669',
    activeFrom: 4400,
    outputs: [{ key: 'out3', type: 'tsx' }],
  },
  { key: 'stage4', color: '#d97706', outputs: [{ key: 'out4', type: 'ts' }] },
  { key: 'stage5', color: '#dc2626', outputs: [{ key: 'out5', type: 'ts' }] },
  { key: 'stage6', color: '#16a34a', outputs: [{ key: 'out6', type: 'zip' }] },
]

const PLAN = [
  { key: 'plan1', doneAt: 4700 },
  { key: 'plan2', doneAt: 5600 },
  { key: 'plan3', doneAt: 7100 },
  { key: 'plan4', doneAt: 8400 },
]

export function StreamScene({ time }: { time: number }) {
  const { t } = useI18n()
  const line1 = typewriter(time, 1000, 2300, t('scene.stream.assistant1'))
  const line2 = typewriter(time, 4600, 6400, t('scene.stream.assistant2'))
  const tool1Done = time >= 3100
  const tool2Done = time >= 4100
  const planDone = PLAN.filter((item) => time >= item.doneAt).length
  const artifactsAt = [6700, 7000, 7300]

  return (
    <div className="scene-body scene-detail">
      <aside className="detail-left">
        <div className="detail-title">{t('scene.stream.title')}</div>
        <div className="detail-progress-label">
          <span>{t('scene.stream.progress')}</span>
          <span className="detail-badge running">
            <Loader2 size={10} className="spin" />
            {t('scene.stream.statusRunning')}
          </span>
        </div>

        <div className="timeline-row">
          {STAGES.map((stage, index) => {
            const done = stage.doneAt !== undefined && time >= stage.doneAt
            const active = stage.activeFrom !== undefined && time >= stage.activeFrom && !done
            const state = done ? 'done' : active ? 'active' : 'pending'
            return (
              <div key={stage.key} className={`timeline-stage is-${state}`}>
                {state === 'active' && (
                  <span className="tl-pill">
                    <Loader2 size={9} className="spin" />
                    {t('scene.stream.statusRunning')}
                  </span>
                )}
                <span className="timeline-dot" style={{ borderColor: stage.color, background: done || active ? stage.color : 'var(--bg)' }}>
                  {done ? '✓' : ''}
                </span>
                {index < STAGES.length - 1 && <span className="tl-connector" style={{ background: done ? stage.color : 'var(--border)' }} />}
                <span className="tl-label">{t(`scene.stream.${stage.key}`)}</span>
              </div>
            )
          })}
        </div>

        <div className="output-label">{t('scene.stream.outputs')}</div>
        <div className="output-list">
          {STAGES.flatMap((stage) =>
            (stage.outputs || []).map((out) => {
              const done =
                out.doneAt !== undefined && time >= out.doneAt
              return (
                <div
                  key={out.key}
                  className={`output-row${done ? ' is-done' : ''}`}
                >
                  <span className="output-arrow">↳</span>
                  <span className="output-dot" />
                  <span className="output-name">
                    {t(`scene.stream.${out.key}`)}
                  </span>
                  <span className="output-type">{out.type}</span>
                  <span
                    className={`output-status${done ? ' is-done' : ''}`}
                  >
                    {done
                      ? t('scene.stream.outputDone')
                      : t('scene.stream.outputPending')}
                  </span>
                </div>
              )
            }),
          )}
        </div>
      </aside>

      <div className="detail-chat">
        <div className="chat-scroll">
          <div className="chat-meta-row">
            <span className="stream-avatar">W</span>
            <span className="chat-meta-name">WorkStep</span>
            <span className="chat-meta-time">10:24</span>
          </div>

          <div className="stream-bubble user" style={{ opacity: arrive(time, 500, 420) }}>
            {t('scene.stream.user')}
          </div>

          <div className="stream-bubble assistant" style={{ opacity: arrive(time, 900, 420) }}>
            <span className="stream-avatar">W</span>
            <span className="stream-bubble-text">{line1 || '\u00a0'}</span>
          </div>

          {time >= 2300 && (
            <div className={`llm-tool${tool1Done ? ' is-done' : ' is-running'}`} style={{ opacity: arrive(time, 2300, 300) }}>
              <span className="llm-tool-icon">
                {tool1Done ? <Check size={12} /> : <Loader2 size={12} className="spin" />}
              </span>
              <span className="llm-tool-name">{t('scene.stream.tool1')}</span>
              {tool1Done && <span className="llm-tool-result">{t('scene.stream.tool1Result')}</span>}
              <span className="llm-tool-chevron">▾</span>
            </div>
          )}

          {time >= 3300 && (
            <div className={`llm-tool${tool2Done ? ' is-done' : ' is-running'}`} style={{ opacity: arrive(time, 3300, 300) }}>
              <span className="llm-tool-icon">
                {tool2Done ? <Check size={12} /> : <Loader2 size={12} className="spin" />}
              </span>
              <span className="llm-tool-name">{t('scene.stream.tool2')}</span>
              {tool2Done && <span className="llm-tool-result">{t('scene.stream.tool2Result')}</span>}
              <span className="llm-tool-chevron">▾</span>
            </div>
          )}

          <div className="stream-bubble assistant" style={{ opacity: arrive(time, 4400, 420) }}>
            <span className="stream-avatar">W</span>
            <span className="stream-bubble-text">{line2 || '\u00a0'}</span>
          </div>

          {time >= 4300 && (
            <div className="plan-card" style={{ opacity: arrive(time, 4300, 400) }}>
              <div className="plan-head">
                <span className="plan-head-pie">
                  <Loader2 size={12} className="spin" />
                  {planDone}/{PLAN.length}
                </span>
                <span className="plan-head-title">{t('scene.stream.plan')}</span>
                <span className="plan-chevron">▾</span>
              </div>
              {PLAN.map((item, index) => {
                const done = time >= item.doneAt
                const active = !done && time >= item.doneAt - 1300
                return (
                  <div key={item.key} className={`plan-item${done ? ' is-done' : ''}${active ? ' is-active' : ''}`} style={{ '--i': index } as CSSProperties}>
                    <span className="plan-item-icon">
                      {done ? <Check size={12} /> : active ? <Loader2 size={12} className="spin" /> : <span className="plan-item-ring" />}
                    </span>
                    <span className="plan-item-label">{t(`scene.stream.${item.key}`)}</span>
                  </div>
                )
              })}
            </div>
          )}

          {time >= 6500 && (
            <>
              <div className="chat-section-label">{t('scene.stream.artifacts')}</div>
              <div className="artifact-list">
                {artifactsAt.map((at, index) => (
                  <div key={at} className="artifact-row2" style={{ opacity: arrive(time, at, 380) }}>
                    <span className="artifact-dot" style={{ background: '#059669' }} />
                    <span className="artifact-name">{t(`scene.stream.artifact${index + 1}`)}</span>
                    <span className="artifact-open">{t('scene.artifacts.open')}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="chat-input-row">
          <span className="chat-input-ph">{t('scene.stream.inputPlaceholder')}</span>
          <span className="chat-send">
            <Send size={13} />
          </span>
        </div>
      </div>
    </div>
  )
}
