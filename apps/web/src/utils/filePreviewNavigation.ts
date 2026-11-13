/** Android already redirects popups into its main WebView. Navigate there directly
 * so preview pages keep the current login without a temporary popup handoff. */
export function openFilePreviewWindow(url: string) {
  const target = new URL(url, window.location.href)
  if (window.WorkStepAndroid && target.origin === window.location.origin) {
    target.searchParams.set('preview_return', '1')
    window.location.assign(target.href)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function closeFilePreviewWindow() {
  if (window.WorkStepAndroid && new URLSearchParams(window.location.search).get('preview_return') === '1') {
    window.history.back()
    return
  }
  window.close()
}
