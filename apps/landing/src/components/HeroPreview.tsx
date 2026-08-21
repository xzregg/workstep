import {
  Archive,
  BarChart2,
  Book,
  ChevronDown,
  Clock,
  ExternalLink,
  Folder,
  FolderOpen,
  Layers,
  Loader2,
  Play,
  Plus,
  Share2,
  Table,
} from 'lucide-react'
import { useI18n } from '../i18n'

interface Lane {
  label: string
  color: string
  cards: Array<{ title: string; desc: string; status: 'done' | 'running' | 'ready' }>
}

export function HeroPreview() {
  const { t } = useI18n()

  const lanes: Lane[] = [
    {
      label: t('heroPreview.laneReq'),
      color: '#0071e3',
      cards: [{ title: t('heroPreview.card1'), desc: t('heroPreview.desc1'), status: 'done' }],
    },
    {
      label: t('heroPreview.laneDesign'),
      color: '#7c3aed',
      cards: [{ title: t('heroPreview.card2'), desc: t('heroPreview.desc2'), status: 'done' }],
    },
    {
      label: t('heroPreview.laneFrontend'),
      color: '#059669',
      cards: [{ title: t('heroPreview.card3'), desc: t('heroPreview.desc3'), status: 'running' }],
    },
    {
      label: t('heroPreview.laneBackend'),
      color: '#d97706',
      cards: [{ title: t('heroPreview.card4'), desc: t('heroPreview.desc4'), status: 'running' }],
    },
  ]

  const statusText = (status: Lane['cards'][number]['status']) =>
    status === 'running'
      ? t('heroPreview.statusRunning')
      : status === 'done'
        ? t('heroPreview.statusDone')
        : t('heroPreview.statusReady')

  return (
    <div className="hero-preview">
      <div className="app-frame">
        <div className="hero-app">
          <aside className="app-sidebar">
            <div className="side-brand">
              <Layers size={18} color="var(--accent)" />
              WorkStep
            </div>
            <div className="side-stat">
              <BarChart2 size={17} />
              {t('heroPreview.statistics')}
            </div>
            <div className="side-section">{t('heroPreview.projects')}</div>
            <div className="side-row is-active">
              <FolderOpen size={15} color="var(--accent)" />
              <span>{t('heroPreview.project')}</span>
              <Loader2 size={11} className="spin" color="var(--accent)" />
            </div>
            <div className="side-nested-head">
              <span>
                <Folder size={13} color="var(--accent)" />
                {t('heroPreview.workflows')}
              </span>
              <Plus size={13} />
            </div>
            <div className="side-row nested is-active">{t('heroPreview.workflow1')}</div>
            <div className="side-row nested">{t('heroPreview.workflow2')}</div>
            <div className="side-row nested">{t('heroPreview.workflow3')}</div>
            <div className="side-nested-head sessions">
              <span>
                <Folder size={13} color="var(--accent)" />
                {t('heroPreview.sessions')}
              </span>
              <Plus size={13} />
            </div>
            <div className="side-session">
              <Loader2 size={11} className="spin" color="var(--accent)" />
              <span>{t('heroPreview.session1')}</span>
            </div>
            <div className="side-session">
              <span className="side-bot">W</span>
              <span>{t('heroPreview.session2')}</span>
            </div>
            <div className="side-add">
              <Plus size={13} />
              {t('heroPreview.newProject')}
            </div>
          </aside>

          <div className="hero-main">
            <div className="app-topbar">
              <span className="tb-btn">
                <Table size={13} />
                {t('heroPreview.editStages')}
              </span>
              <span className="tb-btn tb-primary">
                <Plus size={13} />
                {t('heroPreview.newTask')}
              </span>
              <span className="tb-flow">
                <ExternalLink size={12} />
                {t('heroPreview.workflow1')}
              </span>
              <span className="tb-id">{t('heroPreview.workflowId')}</span>
              <span className="tb-spacer" />
              <span className="tb-btn">
                <Share2 size={12} />
                {t('heroPreview.share')}
              </span>
              <span className="tb-btn">
                <Clock size={12} />
                {t('heroPreview.schedule')}
              </span>
              <span className="tb-btn">
                <Book size={12} />
                {t('heroPreview.memory')}
              </span>
              <span className="tb-btn">
                <Archive size={12} />
                {t('heroPreview.archive')}
              </span>
              <span className="tb-btn">
                {t('heroPreview.openDir')}
                <ChevronDown size={12} />
              </span>
            </div>

            <div className="board-lanes">
              {lanes.map((lane) => (
                <div key={lane.label} className="board-lane">
                  <div className="lane-head">
                    <span className="lane-dot" style={{ background: lane.color }} />
                    <span className="lane-name">{lane.label}</span>
                    <span className="lane-count">{lane.cards.length}</span>
                  </div>
                  <div className="lane-body">
                    {lane.cards.map((card) => (
                      <div key={card.title} className="board-card">
                        <div className="card-title-row">
                          <span className="card-title">{card.title}</span>
                          <span className={`status-badge sb-${card.status}`}>
                            {card.status === 'running' && (
                              <Loader2 size={10} className="spin" />
                            )}
                            {statusText(card.status)}
                          </span>
                        </div>
                        <div className="card-desc">{card.desc}</div>
                        <div className="card-footer">
                          <span className="card-start">
                            <Play size={11} />
                          </span>
                          <span className="card-tokens">12.4k tokens</span>
                        </div>
                        {card.status === 'running' && (
                          <div className="card-progress">
                            <span className="card-progress-fill" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="hero-engine-pills">
        <span className="hero-engine-pill">
          <span className="engine-dot dot-codex" />
          {t('engines.codex')}
          <em>{t('heroPreview.statusRunning')}</em>
        </span>
        <span className="hero-engine-pill">
          <span className="engine-dot dot-claude" />
          {t('engines.claude')}
          <em>{t('heroPreview.statusDone')}</em>
        </span>
        <span className="hero-engine-pill">
          <span className="engine-dot dot-hermes" />
          {t('engines.hermes')}
          <em>{t('heroPreview.statusReady')}</em>
        </span>
      </div>
    </div>
  )
}
