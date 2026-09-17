/**
 * FlowStageApplyPanel — apply only some of an AI flow patch's stages.
 *
 * The AI flow assistant returns incremental patches when editing an existing
 * workflow. Rather than overwriting the whole canvas, this panel lists the
 * stages a proposal touched and lets the user apply just the ones they want,
 * merging them onto the current canvas via `applyWorkflowPatch`.
 */
import { useMemo, useState } from 'react'
import Button from './Button'
import { useI18n } from '../i18n'
import { applyWorkflowPatch, changedStageIds } from '../utils/workflowPatch'
import type { GenProposalCard } from '../stores/workflowGenStore'

export interface FlowStageApplyPanelProps {
  /** Proposals that came from an incremental patch (have stageChanges). */
  cards: GenProposalCard[]
  /** Snapshot of the current canvas to merge the selected stages onto. */
  currentSteps: () => any
  /** Apply the merged canvas (parent decides how to handle unsaved edits). */
  onApply: (steps: any, card: GenProposalCard) => void
  /** Currently applied proposal id, for the applied highlight. */
  appliedCardId?: string | null
  disabled?: boolean
}

import type { TKey } from '../i18n'

const CHANGE_LABEL: Record<string, TKey> = {
  added: 'aiFlow.stageChangeAdded',
  updated: 'aiFlow.stageChangeUpdated',
  removed: 'aiFlow.stageChangeRemoved',
}

export default function FlowStageApplyPanel({
  cards,
  currentSteps,
  onApply,
  appliedCardId,
  disabled,
}: FlowStageApplyPanelProps) {
  const { t } = useI18n()
  // Per-card selection of stage ids; unknown ⇒ default to every changed stage.
  const [selection, setSelection] = useState<Record<string, Set<number>>>({})

  const defaults = useMemo(() => {
    const map: Record<string, Set<number>> = {}
    for (const card of cards) map[card.id] = changedStageIds(card.stageChanges)
    return map
  }, [cards])

  const selectedFor = (card: GenProposalCard) =>
    selection[card.id] ?? defaults[card.id] ?? new Set<number>()

  const toggleStage = (card: GenProposalCard, stageId: number) => {
    const next = new Set(selectedFor(card))
    if (next.has(stageId)) next.delete(stageId)
    else next.add(stageId)
    setSelection((current) => ({ ...current, [card.id]: next }))
  }

  const applyCard = (card: GenProposalCard) => {
    const selected = selectedFor(card)
    if (selected.size === 0) return
    const merged = applyWorkflowPatch(currentSteps(), card.patch ?? {}, selected)
    onApply(merged, card)
  }

  if (cards.length === 0) return null

  return (
    <div style={{
      marginTop: 6, display: 'flex', flexDirection: 'column', gap: 10,
      padding: '10px 12px', borderRadius: 10,
      border: '1px solid var(--border-soft)', background: 'var(--surface)',
    }}>
      <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)' }}>
        {t('aiFlow.stageApplyHint')}
      </div>
      {cards.map((card) => {
        const selected = selectedFor(card)
        const changes = card.stageChanges ?? []
        const applied = appliedCardId === card.id
        return (
          <div key={card.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            }}>
              <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
                {card.title}
              </span>
              <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>
                {t('aiFlow.stageApplyCount', { count: selected.size, total: changes.length })}
              </span>
            </div>
            {changes.map((change) => (
              <label
                key={`${card.id}-${change.id}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(change.id)}
                  onChange={() => toggleStage(card, change.id)}
                  style={{ flexShrink: 0 }}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {change.title || change.key || `#${change.id}`}
                </span>
                <span style={{
                  flexShrink: 0, fontSize: 'calc(11px * var(--font-scale))',
                  color: 'var(--meta)',
                }}>
                  {t(CHANGE_LABEL[change.change] ?? 'aiFlow.stageChangeUpdated')}
                </span>
              </label>
            ))}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => setSelection((current) => ({
                  ...current,
                  [card.id]: new Set(changes.map((entry) => entry.id)),
                }))}
              >
                {t('aiFlow.stageSelectAll')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => setSelection((current) => ({ ...current, [card.id]: new Set() }))}
              >
                {t('aiFlow.stageSelectNone')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={disabled || selected.size === 0}
                onClick={() => applyCard(card)}
              >
                {applied ? t('aiFlow.applied') : t('aiFlow.stageApplyButton')}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
