import { useEffect, useRef, useState } from 'react'
import { engineApi } from '../api/client'
import type { ChatInputWorkflowSkill } from '../components/ChatInput'
import { useI18n } from '../i18n'

interface Options {
  engine: string
  projectId: string
  sessionId: string | null
  input: string
  running: boolean
  onChange: (value: string) => void
  onError: (message: string) => void
  onLoaded?: () => void
}

/** Inserts the enabled skill invocation supplied by the selected engine. */
export function useWorkflowDesignSkill(options: Options): ChatInputWorkflowSkill {
  const { t } = useI18n()
  const conversation = `${options.projectId}/${options.sessionId ?? ''}`
  const scope = `${conversation}/${options.engine}`
  const latest = useRef({ ...options, scope })
  latest.current = { ...options, scope }
  const mounted = useRef(false)
  const pending = useRef<object | null>(null)
  const loaded = useRef<{ scope: string; conversation: string; prompt: string } | null>(null)
  const [state, setState] = useState({ scope, active: false, loading: false })
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const previous = loaded.current
    // Never leave an invocation for the previous engine in the current draft.
    if (previous && previous.conversation === conversation && previous.scope !== scope
      && latest.current.input.startsWith(previous.prompt)) {
      latest.current.onChange(latest.current.input.slice(previous.prompt.length))
    }
    pending.current = null
    loaded.current = null
    setState({ scope, active: false, loading: false })
  }, [scope, conversation])

  return {
    active: state.scope === scope && state.active && Boolean(loaded.current && options.input.startsWith(loaded.current.prompt)),
    loading: state.scope === scope && state.loading,
    disabled: options.running || !options.projectId || !options.sessionId || !options.engine || (state.scope === scope && state.loading),
    onLoad: async () => {
      if (latest.current.running || !options.projectId || !options.sessionId || !options.engine || pending.current || (loaded.current?.scope === scope && latest.current.input.startsWith(loaded.current.prompt))) return
      const request = {}
      pending.current = request
      setState({ scope, active: false, loading: true })
      try {
        const result = await engineApi.inspect(options.engine, options.projectId)
        const prompt = result.input_items?.find(item => item.kind === 'skill' && item.name === 'workstep-exec')?.insert_text
        if (!mounted.current || latest.current.scope !== scope || pending.current !== request) return
        if (!prompt?.trim()) throw new Error(t('chatInput.workflowSkillEmpty'))
        // Edits made while loading belong to the user; append them unchanged.
        const input = latest.current.input
        latest.current.onChange(input.startsWith(prompt) ? input : `${prompt}${input}`)
        loaded.current = { scope, conversation, prompt }
        setState({ scope, active: true, loading: false })
        latest.current.onLoaded?.()
      } catch (reason) {
        if (!mounted.current || latest.current.scope !== scope || pending.current !== request) return
        setState({ scope, active: false, loading: false })
        latest.current.onError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (pending.current === request) pending.current = null
      }
    },
    onRemove: () => {
      if (latest.current.running) return
      const prompt = loaded.current?.scope === scope ? loaded.current.prompt : ''
      if (prompt && latest.current.input.startsWith(prompt)) {
        latest.current.onChange(latest.current.input.slice(prompt.length))
      }
      loaded.current = null
      setState({ scope, active: false, loading: false })
    },
  }
}
