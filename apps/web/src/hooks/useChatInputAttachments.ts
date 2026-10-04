import { useState, type ClipboardEvent, type DragEvent } from 'react'
import { fsApi } from '../api/client'
import type { ChatInputImageAttach } from '../components/ChatInput'
import { useI18n } from '../i18n'
import { formatMarkdownAttachment } from '../utils/markdownAttachment'
import { splitMarkdownImages } from '../utils/markdownImages'

interface AttachmentOptions {
  imageAttach?: ChatInputImageAttach
  valueRef: { current: string }
  cursor: number
  onChange: (value: string) => void
  onCursorChange: (cursor: number) => void
  undoSnapshotRef: { current: { before: string; after: string } | null }
  focusCursor: (markdown: string, cursor: number) => void
}

/** Owns the upload and insertion transaction shared by picker, paste and drop. */
export function useChatInputAttachments({
  imageAttach, valueRef, cursor, onChange, onCursorChange, undoSnapshotRef, focusCursor,
}: AttachmentOptions) {
  const { t } = useI18n()
  const [uploadingImage, setUploadingImage] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  const handleAttachments = async (files: File[]) => {
    if (!imageAttach || files.length === 0) return
    imageAttach.onError?.('')
    setUploadingImage(true)
    const previousValue = valueRef.current
    let nextValue = previousValue
    let nextCursor = Math.max(0, Math.min(cursor, nextValue.length))
    let uploadedAny = false
    try {
      for (const file of files) {
        const isImage = file.type.startsWith('image/')
        try {
          const uploaded = imageAttach.upload
            ? await imageAttach.upload(file, imageAttach.prefix)
            : isImage
              ? await fsApi.uploadImage(file, imageAttach.projectId!, imageAttach.prefix)
              : await fsApi.uploadFile(file, imageAttach.projectId!, imageAttach.prefix)
          const markdown = formatMarkdownAttachment(file, uploaded.url)
          const before = nextValue.slice(0, nextCursor)
          const after = nextValue.slice(nextCursor)
          const beforeEndsWithImage = splitMarkdownImages(before)
            .some((segment) => segment.type === 'image' && segment.end === before.length)
          const afterStartsWithImage = splitMarkdownImages(after)
            .some((segment) => segment.type === 'image' && segment.start === 0)
          const prefix = !isImage && before && !before.endsWith('\n') && !beforeEndsWithImage
            ? '\n\n'
            : ''
          const suffix = !isImage && after && !after.startsWith('\n') && !afterStartsWithImage
            ? '\n\n'
            : ''
          nextValue = before + prefix + markdown + suffix + after
          nextCursor = before.length + prefix.length + markdown.length + suffix.length
          uploadedAny = true
        } catch (reason) {
          imageAttach.onError?.(reason instanceof Error
            ? reason.message
            : isImage ? t('chatInput.imageUploadFailed') : t('chatInput.fileUploadFailed'))
        }
      }
      if (uploadedAny) {
        undoSnapshotRef.current = { before: previousValue, after: nextValue }
        valueRef.current = nextValue
        onChange(nextValue)
        onCursorChange(nextCursor)
        requestAnimationFrame(() => focusCursor(nextValue, nextCursor))
      }
    } finally {
      setUploadingImage(false)
    }
  }

  const handleAttachPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (files.length === 0) return
    event.preventDefault()
    void handleAttachments(files)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!imageAttach) return
    const files = Array.from(event.dataTransfer?.files || [])
    setDragActive(false)
    if (files.length === 0) return
    event.preventDefault()
    void handleAttachments(files)
  }

  return {
    uploadingImage, dragActive, setDragActive, handleAttachments, handleAttachPaste, handleDrop,
  }
}
