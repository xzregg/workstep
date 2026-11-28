import { webrtcWorkspacePath } from '../webrtc/webrtcLocation'

/** Keep previews in the current Android WebView or authenticated P2P tab. */
export function openFilePreviewWindow(url: string) {
  const target = new URL(url, window.location.href)
  const directWorkspace = webrtcWorkspacePath()
  if (target.origin === window.location.origin && (window.WorkStepAndroid
    || (directWorkspace && target.pathname === `${directWorkspace}/file-preview`))) {
    target.searchParams.set('preview_return', '1')
    window.location.assign(target.href)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function closeFilePreviewWindow() {
  if ((window.WorkStepAndroid || webrtcWorkspacePath())
    && new URLSearchParams(window.location.search).get('preview_return') === '1') {
    window.history.back()
    return
  }
  window.close()
}
