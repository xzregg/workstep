import { Table } from 'lucide-react'
import { useI18n } from '../i18n'
import { arrive } from './utils'

interface StageNode {
  id: string
  labelKey: string
  promptKey: string
  engineKey: string
  color: string
  x: number
  y: number
  appearAt: number
}

const NODES: StageNode[] = [
  { id: 'n1', labelKey: 'node1', promptKey: 'prompt1', engineKey: 'engine1', color: '#0071e3', x: 9, y: 40, appearAt: 500 },
  { id: 'n2', labelKey: 'node2', promptKey: 'prompt2', engineKey: 'engine1', color: '#7c3aed', x: 30, y: 40, appearAt: 1300 },
  { id: 'n3', labelKey: 'node3', promptKey: 'prompt3', engineKey: 'engine2', color: '#059669', x: 51, y: 14, appearAt: 2300 },
  { id: 'n4', labelKey: 'node4', promptKey: 'prompt4', engineKey: 'engine2', color: '#d97706', x: 51, y: 64, appearAt: 2400 },
  { id: 'n5', labelKey: 'node5', promptKey: 'prompt5', engineKey: 'engine3', color: '#dc2626', x: 72, y: 40, appearAt: 3700 },
  { id: 'n6', labelKey: 'node6', promptKey: 'prompt6', engineKey: 'engine1', color: '#16a34a', x: 92, y: 40, appearAt: 5100 },
]

const EDGES: Array<[string, string]> = [
  ['n1', 'n2'],
  ['n2', 'n3'],
  ['n2', 'n4'],
  ['n3', 'n5'],
  ['n4', 'n5'],
  ['n5', 'n6'],
]

// 橙色回环线：测试阶段产出未达标时，任务回流到「前端」阶段重做（阶段返工回调）。
const REWORK_LOOP_PATH = 'M 620 215 C 780 45, 690 10, 600 95'
const REWORK_LOOP_AT = 4600

export function CanvasScene({ time }: { time: number }) {
  const { t } = useI18n()
  const byId = new Map(NODES.map((node) => [node.id, node]))
  const dirty = time >= 3200 && time < 5800
  const saved = time >= 6100
  const loopVisible = time >= REWORK_LOOP_AT

  return (
    <div className="scene-body scene-canvas">
      {saved && (
        <div className="canvas-toast">
          {t('scene.canvas.saved')}
        </div>
      )}

      <div className="canvas-topbar">
        <span className="tb-btn">
          <Table size={13} />
          {t('scene.canvas.board')}
        </span>
        <span className="canvas-title">{t('scene.canvas.title')}</span>
        <span className="tb-btn tb-flow">
          {t('scene.board.workflowName')}
          <span className="tb-caret">▾</span>
        </span>
        <span className="tb-btn">{t('scene.canvas.aiEdit')}</span>
        <span className="tb-spacer" />
        <span className="tb-hint">{t('scene.canvas.hint')}</span>
        {dirty && <span className="tb-dirty">{t('scene.canvas.dirtyHint')}</span>}
        <span className="tb-btn">{t('scene.canvas.json')}</span>
        <span className="tb-btn">{t('scene.canvas.layout')}</span>
        <span className="tb-btn">{t('scene.canvas.addStage')}</span>
        <span className={`tb-btn tb-primary${dirty ? ' is-danger' : ''}`}>
          {t('scene.canvas.save')}
        </span>
      </div>

      <div className="canvas-board">
        <svg className="canvas-edges" viewBox="0 0 1000 562" preserveAspectRatio="none" aria-hidden="true">
          {EDGES.map(([from, to]) => {
            const source = byId.get(from)!
            const target = byId.get(to)!
            const start = source.appearAt + 700
            const progress = arrive(time, start, 700)
            const visible = time >= source.appearAt && time >= target.appearAt
            return (
              <line
                key={`${from}-${to}`}
                x1={source.x * 10}
                y1={source.y * 5.62}
                x2={target.x * 10}
                y2={target.y * 5.62}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - progress}
                className={`canvas-edge${visible ? ' is-live' : ''}`}
              />
            )
          })}
          {loopVisible && (
            <g>
              <path
                d={REWORK_LOOP_PATH}
                className="canvas-loop-edge"
                style={{ opacity: arrive(time, REWORK_LOOP_AT, 600) }}
              />
              <circle r="5" fill="#f97316" className="canvas-loop-dot">
                <animateMotion dur="2.2s" repeatCount="indefinite" path={REWORK_LOOP_PATH} />
              </circle>
            </g>
          )}
        </svg>

        {loopVisible && (
          <div className="canvas-loop-tag" style={{ opacity: arrive(time, REWORK_LOOP_AT + 300, 500) }}>
            <span className="canvas-loop-tag-dot" />
            {t('scene.canvas.reworkLabel')}
          </div>
        )}

        {NODES.map((node) => {
          if (time < node.appearAt) return null
          const pop = arrive(time, node.appearAt, 420)
          return (
            <div
              key={node.id}
              className="stage-node"
              style={{
                left: `${node.x}%`,
                top: `${node.y}%`,
                borderColor: node.color,
                opacity: pop,
                transform: 'translate(-50%, -50%) scale(0.78)',
              }}
            >
              <div className="stage-node-head">
                <span className="stage-node-icon" style={{ background: `${node.color}20`, color: node.color }}>
                  {t(`scene.canvas.${node.labelKey}`).charAt(0)}
                </span>
                <span className="stage-node-label">{t(`scene.canvas.${node.labelKey}`)}</span>
                <span className="stage-node-engine">{t(`scene.canvas.${node.engineKey}`)}</span>
              </div>
              <div className="stage-node-prompt">{t(`scene.canvas.${node.promptKey}`)}</div>
              <div className="stage-node-port">
                <span className="port-dot" style={{ background: '#0071e3' }} />
                <span className="port-name">PRD.md</span>
                <span className="port-type">markdown</span>
              </div>
              <div className="stage-node-sub">
                <span className="sub-arrow">↳</span>
                <span className="sub-name">产物清单</span>
                <span className="sub-type">text</span>
                <span className="sub-dot" style={{ background: '#16a34a' }} />
              </div>
              <span className="stage-handle handle-left" />
              <span className="stage-handle handle-right" />
            </div>
          )
        })}
      </div>

      {loopVisible && (
        <div className="canvas-rework-bar" style={{ opacity: arrive(time, REWORK_LOOP_AT + 500, 500) }}>
          <span className="canvas-rework-dot" />
          <span>{t('scene.canvas.reworkDesc')}</span>
        </div>
      )}
    </div>
  )
}
