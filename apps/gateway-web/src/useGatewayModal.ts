import { useEffect, useRef } from 'react'

/** Native modal dialogs share the browser top layer, including nested confirmations. */
export function useGatewayModal() {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = dialog.current
    const focus = document.activeElement as HTMLElement | null
    if (node?.showModal) node.showModal()
    else node?.setAttribute('open', '')
    return () => {
      node?.close?.()
      if (focus?.isConnected) focus.focus()
    }
  }, [])
  return dialog
}
