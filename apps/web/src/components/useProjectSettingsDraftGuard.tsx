import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import { useI18n } from '../i18n'

/** Preserve drafts across tab changes and protect closing while edits remain. */
export function useProjectSettingsDraftGuard(projectId: string | undefined, draft: Record<string, unknown>, busy: boolean, onClose: () => void) {
  const { t } = useI18n()
  const baseline = useRef<{ projectId: string; draft: Record<string, unknown> } | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  useEffect(() => {
    if (baseline.current?.projectId !== projectId) baseline.current = null
    setConfirmClose(false)
  }, [projectId])
  const hasLoaded = useCallback((id: string) => baseline.current?.projectId === id, [])
  const markLoaded = useCallback((id: string, values: Record<string, unknown>) => { baseline.current = { projectId: id, draft: values } }, [])
  const markSaved = useCallback((key: string, value: unknown) => {
    if (baseline.current) baseline.current.draft = { ...baseline.current.draft, [key]: value }
  }, [])
  const saved = baseline.current
  const dirty = !!saved && saved.projectId === projectId && JSON.stringify(saved.draft) !== JSON.stringify(draft)
  const requestClose = () => { if (!busy) { if (dirty) setConfirmClose(true); else onClose() } }
  const confirmation = <ConfirmDialog open={confirmClose} title={t('projectSettings.title')} message={t('actionShortcuts.unsavedClose')}
    confirmText={t('common.discard')} onCancel={() => setConfirmClose(false)} onConfirm={() => { setConfirmClose(false); onClose() }} />
  return { hasLoaded, markLoaded, markSaved, requestClose, confirmation }
}
