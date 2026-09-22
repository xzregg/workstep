import { useSearchParams } from 'react-router-dom'
import ArtifactPreview from '../components/ArtifactPreview'
import Button from '../components/Button'
import { useI18n } from '../i18n'

/**
 * Standalone file preview window. The file preview toolbar is kept inside
 * ArtifactPreview so the dialog and this page expose the same actions.
 */
export default function FilePreviewPage() {
  const { t } = useI18n()
  const [searchParams] = useSearchParams()
  const path = searchParams.get('path') || ''
  const name = searchParams.get('name') || path.split(/[\\/]/).pop() || t('artifact.file')
  const projectId = searchParams.get('project_id') || undefined
  const lineValue = searchParams.get('line')
  const line = lineValue ? Number(lineValue) : undefined

  if (!path) {
    return (
      <div className="standalone-preview-empty">
        <span>{t('artifact.missingPath')}</span>
        <Button variant="ghost" onClick={() => window.close()}>{t('common.close')}</Button>
      </div>
    )
  }

  return (
    <main className="standalone-preview-page">
      <section className="standalone-preview-body">
        <ArtifactPreview
          path={path}
          name={name}
          line={Number.isFinite(line) ? line : undefined}
          projectId={projectId}
          standalone
          onClose={() => window.close()}
        />
      </section>
    </main>
  )
}
