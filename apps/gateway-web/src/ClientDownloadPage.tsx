import { useEffect, useState } from 'react'

type Release = {
  id: string; gateway_id: string; os: string; arch: string; version: string
  filename: string; file_size: number; sha256: string; signature: string
  gateway_public_key_fingerprint: string; minimum_protocol_version: number
  download_url: string
}

export function ClientDownloadPage() {
  const [releases, setReleases] = useState<Release[]>([])
  const [os, setOs] = useState('macos')
  const [arch, setArch] = useState('arm64')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/client-releases', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('安装包目录加载失败。')
        setReleases((await response.json()).releases ?? [])
      })
      .catch((reason) => { if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '安装包目录加载失败。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])

  const selected = releases.filter((release) => release.os === os && release.arch === arch)
  return <section className="gateway-admin-page gateway-download-page">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY</span>
    <h2>安装 WorkStep</h2>
    <p>选择电脑的系统和架构，下载此网关统一提供的受管安装包。安装后在桌面端登录并登记这台电脑。</p>
    <div className="gateway-download-filters">
      <label htmlFor="release-os">操作系统</label>
      <select id="release-os" value={os} onChange={(event) => setOs(event.target.value)}>
        <option value="macos">macOS</option><option value="windows">Windows</option><option value="linux">Linux</option>
      </select>
      <label htmlFor="release-arch">处理器架构</label>
      <select id="release-arch" value={arch} onChange={(event) => setArch(event.target.value)}>
        <option value="arm64">ARM64</option><option value="x64">x64</option>
      </select>
    </div>
    {loading && <p role="status">正在获取安装包…</p>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    {!loading && !error && selected.length === 0 && <p>此系统和架构暂未发布安装包。</p>}
    <ul className="gateway-device-list">{selected.map((release) => <li key={release.id}>
      <div>
        <strong>WorkStep {release.version}</strong>
        <p>{release.filename} · {(release.file_size / 1024 / 1024).toFixed(1)} MB</p>
        <p>SHA-256：<code>{release.sha256}</code></p>
        <p>网关公钥指纹：<code>{release.gateway_public_key_fingerprint}</code></p>
      </div>
      <a className="gateway-download-link" href={release.download_url} download={release.filename}>下载安装包</a>
    </li>)}</ul>
  </section>
}
