import { useEffect, useState } from 'react'
import { fsApi } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import Spinner from './Spinner'
import { languageForFilename } from './CodeFilePreview'
import GitCodeEditor from './git/GitCodeEditor'
import './git/git.css'

interface Props {
  projectId: string
  rootPath?: string
  path: string
  name: string
  onDirtyChange: (dirty: boolean) => void
  onPreview: () => void
}

export default function ProjectDirectoryFileEditor({
  projectId, rootPath, path, name, onDirtyChange, onPreview,
}: Props) {
  const { t } = useI18n()
  const [original, setOriginal] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dirty = original !== null && draft !== original
  const isCode = languageForFilename(name) !== 'plaintext'

  useEffect(() => {
    let active = true
    setOriginal(null)
    setDraft('')
    setError('')
    setLoading(true)
    fsApi.preview(path, projectId)
      .then((preview) => {
        if (!active) return
        if (preview.type !== 'text') {
          setError(t('browser.textOnly'))
          return
        }
        setOriginal(preview.content)
        setDraft(preview.content)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [path, projectId, t])

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  const save = async () => {
    if (original === null || !dirty || saving) return
    setSaving(true)
    setError('')
    try {
      await fsApi.saveContent(projectId, rootPath, path, draft, original)
      setOriginal(draft)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="project-directory-editor">
      <div className="project-directory-editor-heading">
        <strong title={path}>{name}</strong>
        <div className="project-directory-editor-actions">
          <Button variant="ghost" size="sm" onClick={onPreview}>
            {t('browser.previewFile')}
          </Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!dirty || saving} onClick={() => void save()}>
            {t('browser.saveFile')}
          </Button>
        </div>
      </div>
      {error && <div className="project-directory-editor-error" role="alert">{error}</div>}
      {loading ? (
        <div className="project-directory-browser-state"><Spinner size={14} /> {t('common.loading')}</div>
      ) : original !== null && isCode ? (
        <div className="project-directory-editor-code">
          <GitCodeEditor
            filename={name}
            value={draft}
            targetLine={1}
            editable
            ariaLabel={t('browser.editFile', { name })}
            onChange={setDraft}
            onSave={() => void save()}
          />
        </div>
      ) : original !== null ? (
        <textarea
          className="project-directory-editor-textarea"
          aria-label={t('browser.editFile', { name })}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault()
              void save()
            }
          }}
        />
      ) : null}
    </div>
  )
}
