import { useState } from 'react'
import { useI18n } from '../i18n'
import type { LocalDockerImage, SandboxBridge } from '../utils/desktopSandbox'
import Button from './Button'

export default function SandboxImagePicker({ value, online, disabled, scan, onChange }: {
  value: string | null; online: boolean; disabled: boolean
  scan: SandboxBridge['dockerImages']; onChange: (value: string | null) => void
}) {
  const { t } = useI18n()
  const [images, setImages] = useState<LocalDockerImage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scanned, setScanned] = useState(false)
  async function refresh() {
    setLoading(true); setError('')
    try { const result = await scan(); setImages(result.images); setError(result.error || ''); setScanned(true) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }
  return <div className="sandbox-image-picker">
    <label htmlFor="sandbox-image">{t('sandbox.imageSource')}</label>
    <div className="sandbox-directory">
      <select id="sandbox-image" value={value || ''} disabled={disabled || loading} onChange={e => onChange(e.target.value || null)}>
        <option value="">{t(online ? 'sandbox.onlineImage' : 'sandbox.selectLocalImage')}</option>
        {value && !images.some(image => image.id === value) && <option value={value}>{value}</option>}
        {images.map(image => <option key={image.id} value={image.id}>{image.tags.join(', ') || image.id} ({Math.round(image.size / 1048576)} MiB)</option>)}
      </select>
      <Button disabled={disabled || loading} loading={loading} onClick={() => void refresh()}>{t('sandbox.scanDocker')}</Button>
    </div>
    <p>{t('sandbox.localImageDescription')}</p>
    {scanned && !images.length && !error && <p>{t('sandbox.noLocalImage')}</p>}
    {error && <p className="sandbox-error" role="alert">{error}</p>}
  </div>
}
