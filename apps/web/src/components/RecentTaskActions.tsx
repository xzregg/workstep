import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'
import { useRecentVisitsStore, type RecentVisit } from '../stores/recentVisitsStore'
import ArchiveExperienceDialog from './ArchiveExperienceDialog'
import SessionRowActions from './SessionRowActions'

export default function RecentTaskActions({ entry, timestamp, hovered, now }: {
  entry: RecentVisit
  timestamp: string
  hovered: boolean
  now: number
}) {
  const { t } = useI18n()
  const [archiving, setArchiving] = useState(false)
  return <>
    <SessionRowActions session={{ id: entry.id, title: entry.title, updated_at: timestamp }}
      hovered={hovered} now={now} archiveLabel={t('taskList.archiveTask')}
      onArchive={() => setArchiving(true)} />
    {archiving && createPortal(<ArchiveExperienceDialog task={entry} projectId={entry.projectId}
      onClose={() => setArchiving(false)} onArchived={() => {
        useRecentVisitsStore.getState().removeTasks(entry.projectId, [entry.id])
        setArchiving(false)
      }} />, document.body)}
  </>
}
