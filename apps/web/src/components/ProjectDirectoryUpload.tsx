import { useRef, useState } from 'react'
import { fsApi } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import Icon from './Icon'

interface Props {
  projectId: string
  rootPath?: string
  parent: string
  disabled: boolean
  onBeforeUpload: (action: () => void) => void
  onUploaded: () => void
}

export default function ProjectDirectoryUpload({ projectId, rootPath, parent, disabled, onBeforeUpload, onUploaded }: Props) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const upload = async (files: File[]) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    let changed = false
    try {
      for (const file of files) {
        if (file.size > 25_000_000) throw new Error(t('browser.uploadTooLarge'))
        await fsApi.uploadToDirectory(file, projectId, rootPath, parent)
        changed = true
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('browser.uploadFailed'))
    } finally {
      if (changed) onUploaded()
      busyRef.current = false
      setBusy(false)
    }
  }
  return <div className="project-directory-upload">
    <input ref={inputRef} type="file" multiple hidden aria-label={t('browser.uploadFiles')} onChange={event => {
      const files = Array.from(event.target.files || [])
      event.target.value = ''
      if (files.length) onBeforeUpload(() => { void upload(files) })
    }} />
    <Button variant="icon" className="project-directory-upload-button" loading={busy} disabled={disabled || busy}
      aria-label={t('browser.uploadFiles')} title={t('browser.uploadTarget', { path: parent || t('browser.projectRoot') })}
      onClick={() => inputRef.current?.click()}><Icon name="upload" size={14} /></Button>
    {error && <div className="project-directory-upload-error" role="alert">{error}</div>}
  </div>
}
