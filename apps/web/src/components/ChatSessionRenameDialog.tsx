import { useState } from 'react'
import { chatSessionApi } from '../api/client'
import { useI18n } from '../i18n'
import { useChatListStore } from '../stores/chatSessionStore'
import ConfirmDialog from './ConfirmDialog'
import Input from './Input'

interface ChatSessionRenameDialogProps {
  projectId: string
  sessionId: string
  title: string
  onRenamed: (title: string) => void
  onClose: () => void
}

export default function ChatSessionRenameDialog({
  projectId, sessionId, title, onRenamed, onClose,
}: ChatSessionRenameDialogProps) {
  const { t } = useI18n()
  const [value, setValue] = useState(title)
  const [error, setError] = useState('')
  const [renaming, setRenaming] = useState(false)

  const rename = async () => {
    const nextTitle = value.trim()
    if (!nextTitle || renaming) return
    setRenaming(true)
    setError('')
    try {
      const updated = await chatSessionApi.rename(sessionId, projectId, nextTitle)
      useChatListStore.getState().renameSession(sessionId, updated.title)
      onRenamed(updated.title)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('chatSession.renameFailed'))
    } finally {
      setRenaming(false)
    }
  }

  return <ConfirmDialog
    open
    title={t('common.rename')}
    confirmText={t('common.save')}
    loading={renaming}
    confirmDisabled={!value.trim()}
    onConfirm={() => { void rename() }}
    onCancel={() => { if (!renaming) onClose() }}
  >
    <div className="chat-session-rename-form">
      <Input
        autoFocus
        className="chat-session-rename-input"
        value={value}
        onChange={(event) => { setValue(event.target.value); setError('') }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void rename()
          if (event.key === 'Escape' && !renaming) onClose()
        }}
        placeholder={t('chatSession.renamePlaceholder')}
      />
      {error && <div className="chat-session-rename-error" role="alert">{error}</div>}
    </div>
  </ConfirmDialog>
}
