import { useEffect, useState } from 'react'

/** Live message time also catches up when a suspended browser/WebView resumes. */
export function useMessageClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    let timer: number
    const restart = () => {
      window.clearInterval(timer)
      setNow(Date.now())
      timer = window.setInterval(() => setNow(Date.now()), 1000)
    }
    const visible = () => { if (!document.hidden) restart() }
    restart()
    window.addEventListener('workstep:resume', restart)
    window.addEventListener('pageshow', restart)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('workstep:resume', restart)
      window.removeEventListener('pageshow', restart)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [running])
  return now
}
