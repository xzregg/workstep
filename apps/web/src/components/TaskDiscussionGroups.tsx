import { useEffect, useState } from 'react'
import { channelBotApi, type ChannelBot, type DiscussionGroup } from '../api/channelBots'
import { useI18n } from '../i18n'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Input from './Input'
import './TaskDiscussionGroups.css'

interface Props { open: boolean; projectId: string; taskId: string; onClose: () => void }

export default function TaskDiscussionGroups({ open, projectId, taskId, onClose }: Props) {
  const { t } = useI18n()
  const [bots, setBots] = useState<ChannelBot[]>([])
  const [groups, setGroups] = useState<DiscussionGroup[]>([])
  const [recent, setRecent] = useState<string[]>([])
  const [botId, setBotId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removeGroup, setRemoveGroup] = useState<DiscussionGroup | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const requestClose = () => {
    if (groupId.trim()) setDiscardOpen(true)
    else onClose()
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.all([channelBotApi.list(), channelBotApi.taskGroups(taskId, projectId)]).then(([botRows, groupRows]) => {
      if (cancelled) return
      setBots(botRows)
      setGroups(groupRows)
      setBotId((current) => current || botRows[0]?.id || '')
    }).catch((reason) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [open, projectId, taskId])

  useEffect(() => {
    if (!open || !botId) return
    let cancelled = false
    void channelBotApi.recentGroups(botId).then((rows) => {
      if (!cancelled) setRecent(rows.map((row) => row.group_id))
    }).catch((reason) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [open, botId])

  const bind = async () => {
    if (!botId || !groupId.trim()) return
    setBusy(true)
    setError('')
    try {
      await channelBotApi.bindGroup(taskId, projectId, botId, groupId.trim())
      setGroups(await channelBotApi.taskGroups(taskId, projectId))
      setGroupId('')
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  const unbind = async () => {
    if (!removeGroup) return
    setBusy(true)
    try {
      await channelBotApi.unbindGroup(taskId, projectId, removeGroup.bot_id, removeGroup.group_id)
      setGroups(await channelBotApi.taskGroups(taskId, projectId))
      setRemoveGroup(null)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  return <>
    <ConfirmDialog open={open} title={t('channelBot.discussionGroups')} message={t('channelBot.discussionHint')}
      confirmText={t('channelBot.bind')} confirmDisabled={!botId || !groupId.trim()} loading={busy}
      onCancel={requestClose} onConfirm={() => void bind()} width={540}>
      <div className="task-discussion-groups">
        <div className="task-discussion-groups-list">
          {groups.map((group) => <div key={`${group.bot_id}:${group.group_id}`} className="task-discussion-groups-row">
            <span>{bots.find((bot) => bot.id === group.bot_id)?.name || group.bot_id} · {group.group_id}</span>
            <Button variant="ghost" onClick={() => setRemoveGroup(group)}>{t('channelBot.unbind')}</Button>
          </div>)}
          {!groups.length && <p>{t('channelBot.noGroups')}</p>}
        </div>
        {!bots.length && <p>{t('channelBot.noBots')}</p>}
        <label>{t('channelBot.robot')}<select value={botId} onChange={(event) => { setBotId(event.target.value); setGroupId('') }}>
          {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
        </select></label>
        <label>{t('channelBot.groupId')}<Input value={groupId} list="task-discussion-recent-groups" onChange={(event) => setGroupId(event.target.value)} /></label>
        <datalist id="task-discussion-recent-groups">{recent.map((id) => <option key={id} value={id} />)}</datalist>
        <p>{t('channelBot.groupIdHint')}</p>
        {error && <p className="task-discussion-groups-error" role="alert">{error}</p>}
      </div>
    </ConfirmDialog>
    <ConfirmDialog open={!!removeGroup} title={t('channelBot.unbind')} message={t('channelBot.unbindHint')} danger loading={busy}
      onCancel={() => setRemoveGroup(null)} onConfirm={() => void unbind()} />
    <ConfirmDialog open={discardOpen} title={t('channelBot.discardTitle')} message={t('channelBot.discardHint')}
      danger onCancel={() => setDiscardOpen(false)} onConfirm={() => { setDiscardOpen(false); setGroupId(''); onClose() }} />
  </>
}
