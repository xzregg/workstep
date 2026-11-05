import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'
import { gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'

/** Let the mounted app consume notification links before Android loads another document. */
export function useAndroidNotificationNavigation() {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string; handled?: boolean }>).detail
      if (!detail || typeof detail.url !== 'string') return
      try {
        const target = new URL(detail.url, window.location.href)
        if (target.origin !== window.location.origin) return
        const prefix = gatewayWorkspacePath()
        let route = target.pathname
        if (prefix && route.startsWith(prefix + '/')) route = route.slice(prefix.length)
        else if (prefix) {
          const scope = target.searchParams.get('project')?.split('/')
          if (!scope || scope.length !== 3 || scope[0] !== 'gateway'
            || scope[1] !== decodeURIComponent(prefix.split('/')[2])) return
          const { projects, activeProject } = useProjectStore.getState()
          const project = [...projects, ...(activeProject ? [activeProject] : [])].find(item => item.id === scope[2])
          if (!project) return
          target.searchParams.set('project', project.name)
        }
        const key = route === '/chat' ? 'session' : route === '/tasks' ? 'task' : null
        const project = target.searchParams.get('project')
        const id = key && target.searchParams.get(key)
        if (!key || !project || !id) return
        const current = new URLSearchParams(location.search)
        if (route !== location.pathname || project !== current.get('project') || id !== current.get(key))
          navigate(route + target.search)
        detail.handled = true
        window.dispatchEvent(new Event('workstep:resume'))
      } catch { /* Android retains the ordinary navigation fallback for unknown links. */ }
    }
    window.addEventListener('workstep:open-notification', open)
    return () => window.removeEventListener('workstep:open-notification', open)
  }, [location.pathname, location.search, navigate])
}
