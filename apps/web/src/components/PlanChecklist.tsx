import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import type { PlanSnapshot } from '../utils/plan'

interface Props {
  plan: PlanSnapshot
}

/* ── Rolling digit: animates a single character slot up on change ── */

function RollDigit({ char }: { char: string }) {
  const prev = useRef(char)
  const [roll, setRoll] = useState<{ from: string; to: string } | null>(null)
  const [up, setUp] = useState(false)

  useEffect(() => {
    if (char === prev.current) return
    const from = prev.current
    prev.current = char
    setRoll({ from, to: char })
    setUp(false)
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setUp(true)))
    const done = setTimeout(() => setRoll(null), 380)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(done)
    }
  }, [char])

  if (!roll) return <span className="plan-roll-digit">{char}</span>
  return (
    <span className="plan-roll-digit">
      <span className={`plan-roll-inner${up ? ' on' : ''}`}>
        <span>{roll.from}</span>
        <span>{roll.to}</span>
      </span>
    </span>
  )
}

function RollingCount({ value }: { value: string }) {
  return (
    <span className="plan-roll-count">
      {value.split('').map((c, i) => (
        <RollDigit key={i} char={c} />
      ))}
    </span>
  )
}

/* ── SVG icons ── */

function CheckIcon({ on }: { on?: boolean }) {
  return (
    <svg
      className={`plan-icon${on ? ' on' : ''}`}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path
        d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ArrowIcon({ on }: { on?: boolean }) {
  return (
    <svg
      className={`plan-icon plan-icon-strong${on ? ' on' : ''}`}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path
        d="m12.75 15 3-3m0 0-3-3m3 3h-7.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DashedIcon({ on }: { on?: boolean }) {
  return (
    <svg
      className={`plan-icon${on ? ' on' : ''}`}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeDasharray="1.8 3.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function FilledCheckIcon() {
  return (
    <svg className="plan-head-check" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
        fill="currentColor"
      />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg className="plan-list-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg className="plan-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="m19.5 8.25-7.5 7.5-7.5-7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DetailChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`plan-detail-chevron${expanded ? ' is-expanded' : ''}`}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        d="m5.5 3.75 4 4.25-4 4.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/* ── Main component ── */

export default function PlanChecklist({ plan }: Props) {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(false)
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(() => new Set())
  const detailsId = useId()

  const hasActive = plan.entries.some((e) => e.status === 'in_progress')
  const allDone = plan.completed >= plan.total && plan.total > 0
  const running = hasActive && !allDone
  const pct = plan.total > 0 ? Math.round((plan.completed / plan.total) * 100) : 0

  const headerIcon = allDone ? (
    <FilledCheckIcon />
  ) : running ? (
    <span
      className="plan-head-pie"
      style={{ '--plan-pie': `${pct}%` } as React.CSSProperties}
      aria-hidden="true"
    >
      <svg className="plan-head-pie-ring" viewBox="0 0 24 24">
        <circle
          cx="12"
          cy="12"
          r="10.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeDasharray="2.2 4.4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  ) : (
    <ListIcon />
  )

  return (
    <div className="plan-checklist">
      <button
        type="button"
        className="plan-head"
        aria-expanded={!collapsed}
        aria-label={t('plan.title')}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="plan-head-icon">
          {headerIcon}
          <ChevronIcon />
        </span>
        <span className="plan-head-title">{t('plan.title')}</span>
        {plan.explanation && (
          <span className="plan-head-explanation">{plan.explanation}</span>
        )}
        <span className="plan-head-count">
          <RollingCount value={`${plan.completed}/${plan.total}`} />
        </span>
      </button>

      <div className={`plan-body-wrap${collapsed ? ' is-collapsed' : ''}`}>
        <div className="plan-body-inner">
          <ul className="plan-list">
            {plan.entries.map((entry, index) => {
              const done = entry.status === 'completed'
              const active = entry.status === 'in_progress'
              const entryKey = `${index}:${entry.content}`
              const detailExpanded = expandedDetails.has(entryKey)
              const detailId = `${detailsId}-detail-${index}`
              return (
                <li
                  key={entryKey}
                  className={`plan-item${done ? ' done' : ''}${active ? ' active' : ''}`}
                  style={{ '--i': index } as React.CSSProperties}
                >
                  <span className="plan-icon-wrap">
                    <DashedIcon on={!done && !active} />
                    <ArrowIcon on={active} />
                    <CheckIcon on={done} />
                  </span>
                  <span className="plan-copy">
                    <span className="plan-line">
                      {entry.detail ? (
                        <button
                          type="button"
                          className="plan-detail-toggle"
                          aria-expanded={detailExpanded}
                          aria-controls={detailId}
                          aria-label={t(
                            detailExpanded ? 'plan.hideDetails' : 'plan.showDetails',
                            { step: entry.content },
                          )}
                          onClick={() => setExpandedDetails((current) => {
                            const next = new Set(current)
                            if (next.has(entryKey)) next.delete(entryKey)
                            else next.add(entryKey)
                            return next
                          })}
                        >
                          <span className="plan-label" data-label={entry.content}>
                            {entry.content}
                          </span>
                          <DetailChevronIcon expanded={detailExpanded} />
                        </button>
                      ) : (
                        <span className="plan-label" data-label={entry.content}>
                          {entry.content}
                        </span>
                      )}
                    </span>
                    {entry.detail && detailExpanded && (
                      <span id={detailId} className="plan-detail">
                        {entry.detail}
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      </div>

      {plan.total > 0 && !collapsed && (
        <div className="plan-footer">
          {t('plan.progress', {
            current: Math.min(plan.completed + (hasActive ? 1 : 0), plan.total),
            total: plan.total,
            completed: plan.completed,
          })}
        </div>
      )}
    </div>
  )
}
