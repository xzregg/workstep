import { useEffect, useState } from 'react'

export function useDelayedPending(pending: boolean) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!pending) {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => setVisible(true), 250)
    return () => clearTimeout(timer)
  }, [pending])
  return pending && visible
}
