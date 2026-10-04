import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { channelBotApi, type ChannelBot, type DiscussionGroup } from '../api/channelBots'
import { useI18n } from '../i18n'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Input from './Input'
import './TaskDiscussionGroups.css'

interface Props { projectId: string; taskId: string }

export default function TaskDiscussionGroups({ projectId, taskId }: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [bindingState, setBindingState] = useState<{ key: string; groups: DiscussionGroup[] }>({ key: '', groups: [] })
  const key = `${projectId}:${taskId}`
  const keyRef = useRef(key)
  keyRef.current = key
  const openRef = useRef(open)
  openRef.current = open
  const groups = bindingState.key === key ? bindingState.groups : []
  const refreshGroups = useCallback(async () => {
    const rows = await channelBotApi.taskGroups(taskId, projectId)
    if (keyRef.current === key) setBindingState({ key, groups: rows })
  }, [key, projectId, taskId])

  useEffect(() => {
    void refreshGroups().catch(() => undefined)
    const timer = window.setInterval(() => {
      if (!openRef.current) void refreshGroups().catch(() => undefined)
    }, 10000)
    return () => window.clearInterval(timer)
  }, [refreshGroups])

  return <>
    <Button className="task-detail-discussion-button" variant="ghost"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); setOpen(true) }}>
      {groups.length ? t('channelBot.boundButton') : t('channelBot.discussionGroups')}
    </Button>
    {createPortal(<TaskDiscussionGroupsDialog open={open} projectId={projectId} taskId={taskId}
      groups={groups} onChanged={refreshGroups} onClose={() => { setOpen(false); void refreshGroups().catch(() => undefined) }} />, document.body)}
  </>
}

interface DialogProps extends Props { open: boolean; groups: DiscussionGroup[]; onChanged: () => Promise<void>; onClose: () => void }

function TaskDiscussionGroupsDialog({ open, projectId, taskId, groups, onChanged, onClose }: DialogProps) {
  const { t } = useI18n()
  const [bots, setBots] = useState<ChannelBot[]>([])
  const [recent, setRecent] = useState<Array<{ group_id: string; group_name?: string; conversation_title?: string }>>([])
  const [botId, setBotId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [groupName, setGroupName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removeGroup, setRemoveGroup] = useState<DiscussionGroup | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const boundGroup = bots.find((bot) => bot.id === botId)?.task_bindings?.find((group) => group.group_id === groupId.trim())
    || groups.find((group) => group.bot_id === botId && group.group_id === groupId.trim())
  const boundElsewhere = boundGroup && (boundGroup.project_id !== projectId || boundGroup.task_id !== taskId)
  const requestClose = () => {
    if (groupId.trim() || groupName.trim()) setDiscardOpen(true)
    else onClose()
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void channelBotApi.list().then((botRows) => {
      if (cancelled) return
      setBots(botRows)
      setBotId((current) => current || botRows[0]?.id || '')
    }).catch((reason) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (!open || !botId) return
    let cancelled = false
    void channelBotApi.recentGroups(botId).then((rows) => {
      if (!cancelled) setRecent(rows)
    }).catch((reason) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [open, botId])

  const bind = async () => {
    if (!botId || !groupId.trim() || boundGroup) return
    setBusy(true)
    setError('')
    try {
      await channelBotApi.bindGroup(taskId, projectId, botId, groupId.trim(), groupName.trim())
      await onChanged()
      setGroupId('')
      setGroupName('')
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  const unbind = async () => {
    if (!removeGroup) return
    setBusy(true)
    try {
      await channelBotApi.unbindGroup(taskId, projectId, removeGroup.bot_id, removeGroup.group_id)
      await onChanged()
      setRemoveGroup(null)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  return <>
    <ConfirmDialog open={open} title={t('channelBot.discussionGroups')} message={t('channelBot.discussionHint')}
      confirmText={t('channelBot.bind')} confirmDisabled={!botId || !groupId.trim() || !!boundGroup} loading={busy}
      onCancel={requestClose} onConfirm={() => void bind()} width={540}>
      <div className="task-discussion-groups">
        <div className="task-discussion-groups-list">
          {groups.map((group) => <div key={`${group.bot_id}:${group.group_id}`} className="task-discussion-groups-row">
            <span>{bots.find((bot) => bot.id === group.bot_id)?.name || group.bot_id} · {group.group_name || t('channelBot.unknownGroup')} · {group.group_id}</span>
            <Button variant="ghost" onClick={() => setRemoveGroup(group)}>{t('channelBot.unbind')}</Button>
          </div>)}
          {!groups.length && <p>{t('channelBot.noGroups')}</p>}
        </div>
        {!bots.length && <p>{t('channelBot.noBots')}</p>}
        <label>{t('channelBot.robot')}<select value={botId} onChange={(event) => { setBotId(event.target.value); setGroupId(''); setGroupName(''); setRecent([]) }}>
          {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
        </select></label>
        <label>{t('channelBot.recentGroups')}<select aria-label={t('channelBot.recentGroups')}
          value={recent.some((group) => group.group_id === groupId) ? groupId : ''} disabled={!recent.length || busy}
          onChange={(event) => { setGroupId(event.target.value); setGroupName(recent.find((group) => group.group_id === event.target.value)?.group_name || '') }}>
          <option value="">{t('channelBot.selectGroup')}</option>
          {recent.map((group) => {
            const binding = bots.find((bot) => bot.id === botId)?.task_bindings?.find((row) => row.group_id === group.group_id)
              || groups.find((row) => row.bot_id === botId && row.group_id === group.group_id)
            const destination = binding && 'project_name' in binding && 'task_title' in binding
              ? `${binding.project_name} · ${binding.task_title}` : t('channelBot.currentTask')
            return <option key={group.group_id} value={group.group_id} disabled={!!binding}>
              {group.group_name || group.conversation_title || t('channelBot.unknownGroup')} · {group.group_id}{binding ? ` · ${t('channelBot.boundTo')} ${destination}` : ''}
            </option>
          })}
        </select></label>
        <label>{t('channelBot.groupId')}<Input value={groupId} onChange={(event) => { setGroupId(event.target.value); setGroupName(recent.find((group) => group.group_id === event.target.value)?.group_name || '') }} /></label>
        {boundGroup && <p className="task-discussion-groups-error">{t('channelBot.boundTo')} {boundElsewhere && 'project_name' in boundGroup && 'task_title' in boundGroup
          ? `${boundGroup.project_name} · ${boundGroup.task_title}` : t('channelBot.currentTask')}</p>}
        <p>{t('channelBot.groupIdHint')}</p>
        {error && <p className="task-discussion-groups-error" role="alert">{error}</p>}
      </div>
    </ConfirmDialog>
    <ConfirmDialog open={!!removeGroup} title={t('channelBot.unbind')} message={t('channelBot.unbindHint')} danger loading={busy}
      onCancel={() => setRemoveGroup(null)} onConfirm={() => void unbind()} />
    <ConfirmDialog open={discardOpen} title={t('channelBot.discardTitle')} message={t('channelBot.discardHint')}
      danger onCancel={() => setDiscardOpen(false)} onConfirm={() => { setDiscardOpen(false); setGroupId(''); setGroupName(''); onClose() }} />
  </>
}
