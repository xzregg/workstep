export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_for_session'
  | 'allow_always'
  | 'reject_once'
  | 'reject_for_session'
  | 'reject_always'

export interface PermissionOption {
  option_id: string
  name: string
  kind: PermissionOptionKind
}

export interface InteractionSchemaProperty {
  type?: 'string' | 'array' | 'boolean' | 'number' | 'integer'
  title?: string
  description?: string
  enum?: string[]
  oneOf?: Array<{ const: string; title?: string; description?: string }>
  items?: {
    enum?: string[]
    oneOf?: Array<{ const: string; title?: string; description?: string }>
  }
  _meta?: { allowInput?: boolean }
}

export interface InteractionRequestData {
  interaction_id: string
  method: 'session/request_permission' | 'elicitation/create'
  session_id?: string
  tool_call_id?: string
  tool_call?: {
    tool_call_id?: string
    id?: string
    title?: string
    name?: string
    kind?: string
    raw_input?: unknown
    input?: unknown
  }
  options?: PermissionOption[]
  message?: string
  requested_schema?: {
    type?: string
    title?: string
    description?: string
    properties?: Record<string, InteractionSchemaProperty>
    required?: string[]
  }
}

export interface InteractionFieldOption {
  value: string
  label: string
  description: string
  kind?: PermissionOptionKind
}

export interface InteractionField {
  id: string
  title: string
  description: string
  type: 'single' | 'multiple' | 'text' | 'boolean' | 'number'
  required: boolean
  allowInput: boolean
  options: InteractionFieldOption[]
}

export interface InteractionForm {
  id: string
  title: string
  fields: InteractionField[]
}

export interface InteractionEvent {
  type?: string
  data?: Record<string, unknown>
  name?: string
  value?: Record<string, unknown>
}

export interface InteractionItem {
  request: InteractionRequestData
  response?: Record<string, unknown>
}

export function mergeInteractionEvents(
  persisted: InteractionEvent[] = [],
  live: InteractionEvent[] = [],
): InteractionEvent[] {
  if (live.length === 0) return persisted
  const liveKeys = new Set(live.flatMap((event) => {
    const eventKey = event.type === 'CUSTOM' ? event.name : event.type
    const data = isCustom(event, CUSTOM.interactionRequest)
      || isCustom(event, CUSTOM.interactionResponse)
      ? customValue(event)
      : event.data
    if (
      event.type !== 'interaction_request'
      && event.type !== 'interaction_response'
      && !isCustom(event, CUSTOM.interactionRequest)
      && !isCustom(event, CUSTOM.interactionResponse)
    ) return []
    const id = String(data?.interaction_id || '')
    return id ? [`${eventKey}:${id}`] : []
  }))
  const preserved = persisted.filter((event) => {
    const eventKey = event.type === 'CUSTOM' ? event.name : event.type
    const data = isCustom(event, CUSTOM.interactionRequest)
      || isCustom(event, CUSTOM.interactionResponse)
      ? customValue(event)
      : event.data
    if (
      event.type !== 'interaction_request'
      && event.type !== 'interaction_response'
      && !isCustom(event, CUSTOM.interactionRequest)
      && !isCustom(event, CUSTOM.interactionResponse)
    ) return false
    const id = String(data?.interaction_id || '')
    return Boolean(id) && !liveKeys.has(`${eventKey}:${id}`)
  })
  return [...preserved, ...live]
}

export function interactionItemsFromEvents(
  events: InteractionEvent[],
): InteractionItem[] {
  const responses = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    const isResponse = event.type === 'interaction_response'
      || isCustom(event, CUSTOM.interactionResponse)
    if (!isResponse) continue
    const data = isCustom(event, CUSTOM.interactionResponse)
      ? customValue(event)
      : event.data
    const id = String(data?.interaction_id || '')
    const response = data?.response
    if (id && response && typeof response === 'object') {
      responses.set(id, response as Record<string, unknown>)
    }
  }
  return events.flatMap((event) => {
    if (
      event.type !== 'interaction_request'
      && !isCustom(event, CUSTOM.interactionRequest)
    ) return []
    const data = (
      isCustom(event, CUSTOM.interactionRequest)
        ? customValue(event)
        : event.data
    ) as unknown as InteractionRequestData
    if (!data?.interaction_id || !data.method) return []
    return [{ request: data, response: responses.get(data.interaction_id) }]
  })
}

function schemaOptions(
  property: InteractionSchemaProperty,
): InteractionFieldOption[] {
  const choices = property.oneOf ?? property.items?.oneOf
  if (choices) {
    return choices.map((choice) => ({
      value: String(choice.const),
      label: String(choice.title || choice.const),
      description: String(choice.description || ''),
    }))
  }
  const values = property.enum ?? property.items?.enum ?? []
  return values.map((value) => ({
    value: String(value),
    label: String(value),
    description: '',
  }))
}

/**
 * Interaction items still awaiting a user decision. Answered items are
 * dropped so the permission/question card disappears after the user acts
 * on it — and stays gone after a reload once the response is persisted.
 */
export function pendingInteractionItems(
  events: InteractionEvent[],
  enabled = true,
): InteractionItem[] {
  if (!enabled) return []
  return interactionItemsFromEvents(events).filter((item) => !item.response)
}

export function interactionForm(request: InteractionRequestData): InteractionForm {
  if (request.method === 'session/request_permission') {
    const title = request.tool_call?.title || request.tool_call?.name || '权限确认'
    return {
      id: request.interaction_id,
      title,
      fields: [{
        id: 'permission',
        title: '是否允许这项操作？',
        description: '',
        type: 'single',
        required: true,
        allowInput: false,
        options: (request.options || []).map((option) => ({
          value: option.option_id,
          label: option.name,
          description: '',
          kind: option.kind,
        })),
      }],
    }
  }

  const schema = request.requested_schema || {}
  const required = new Set(schema.required || [])
  const fields = Object.entries(schema.properties || {}).map(([id, property]) => {
    const options = schemaOptions(property)
    const type: InteractionField['type'] = property.type === 'array'
      ? 'multiple'
      : property.type === 'boolean'
        ? 'boolean'
        : property.type === 'number' || property.type === 'integer'
          ? 'number'
          : options.length > 0
            ? 'single'
            : 'text'
    return {
      id,
      title: property.title || id,
      description: property.description || '',
      type,
      required: required.has(id),
      allowInput: Boolean(property._meta?.allowInput) || type === 'text',
      options,
    }
  })
  return {
    id: request.interaction_id,
    title: request.message || schema.title || schema.description || '需要你的输入',
    fields,
  }
}

export type InteractionValues = Record<string, string | string[] | boolean | number>

export function buildInteractionResponse(
  request: InteractionRequestData,
  values: InteractionValues,
): Record<string, unknown> {
  if (request.method === 'session/request_permission') {
    const selected = String(values.permission || '')
    return selected
      ? { outcome: { outcome: 'selected', option_id: selected } }
      : { outcome: { outcome: 'cancelled' } }
  }
  return { action: 'accept', content: values }
}

export function cancelInteractionResponse(
  request: InteractionRequestData,
): Record<string, unknown> {
  return request.method === 'session/request_permission'
    ? { outcome: { outcome: 'cancelled' } }
    : { action: 'cancel' }
}

const ALLOW_OPTION_PREFERENCE: PermissionOptionKind[] = [
  'allow_once', 'allow_for_session', 'allow_always',
]
const DENY_OPTION_PREFERENCE: PermissionOptionKind[] = [
  'reject_once', 'reject_for_session', 'reject_always',
]

function pickPermissionOption(
  request: InteractionRequestData,
  allow: boolean,
): PermissionOption | undefined {
  const options = request.options || []
  const preference = allow ? ALLOW_OPTION_PREFERENCE : DENY_OPTION_PREFERENCE
  return preference
    .map((kind) => options.find((option) => option.kind === kind))
    .find(Boolean)
    ?? options.find((option) => option.kind.startsWith(allow ? 'allow' : 'reject'))
}

export function permissionDecision(
  request: InteractionRequestData,
  allow: boolean,
): Record<string, unknown> {
  const option = pickPermissionOption(request, allow)
  return option
    ? { outcome: { outcome: 'selected', option_id: option.option_id } }
    : cancelInteractionResponse(request)
}

export function interactionValuesValid(
  form: InteractionForm,
  values: InteractionValues,
): boolean {
  return form.fields.every((field) => {
    if (!field.required) return true
    const value = values[field.id]
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'string') return value.trim().length > 0
    return value !== undefined && value !== null
  })
}
import { CUSTOM, customValue, isCustom } from './agui.ts'
