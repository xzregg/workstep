/** ACP interaction form and reply shapes used by the standalone Gateway share page. */

type Choice = { const: string; title?: string; description?: string }
type Property = { type?: string; title?: string; description?: string; enum?: string[];
  oneOf?: Choice[]; items?: { enum?: string[]; oneOf?: Choice[] }; _meta?: { allowInput?: boolean } }
export type InteractionRequestData = {
  interaction_id: string; method: 'session/request_permission' | 'elicitation/create';
  tool_call?: { title?: string; name?: string; raw_input?: unknown; input?: unknown };
  options?: Array<{ option_id: string; name: string; kind?: string }>;
  message?: string; mode?: 'form' | 'url'; url?: string;
  requested_schema?: { title?: string; description?: string;
    properties?: Record<string, Property>; required?: string[] };
}
export type InteractionValues = Record<string, string | string[] | boolean | number>
type Field = { id: string; title: string; description: string;
  type: 'single' | 'multiple' | 'text' | 'boolean' | 'number'; required: boolean;
  allowInput: boolean; options: Array<{ value: string; label: string }> }

function options(property: Property): Field['options'] {
  const choices = property.oneOf ?? property.items?.oneOf
  if (choices) return choices.map(choice => ({
    value: String(choice.const), label: String(choice.title || choice.const),
  }))
  return (property.enum ?? property.items?.enum ?? []).map(value => ({
    value: String(value), label: String(value),
  }))
}

export function interactionForm(request: InteractionRequestData): { title: string; fields: Field[] } {
  if (request.method === 'session/request_permission') return {
    title: request.tool_call?.title || request.tool_call?.name || '权限确认',
    fields: [{ id: 'permission', title: '是否允许这项操作？', description: '',
      type: 'single', required: true, allowInput: false,
      options: (request.options ?? []).map(option => ({
        value: option.option_id, label: option.name,
      })) }],
  }
  const schema = request.requested_schema ?? {}
  const required = new Set(schema.required ?? [])
  return {
    title: request.message || schema.title || schema.description || '需要你的输入',
    fields: Object.entries(schema.properties ?? {}).map(([id, property]) => {
      const choices = options(property)
      const type: Field['type'] = property.type === 'array' ? 'multiple'
        : property.type === 'boolean' ? 'boolean'
        : property.type === 'number' || property.type === 'integer' ? 'number'
        : choices.length > 0 ? 'single' : 'text'
      return { id, title: property.title || id, description: property.description || '',
        type, required: required.has(id), allowInput: Boolean(property._meta?.allowInput)
          || type === 'text', options: choices }
    }),
  }
}

export function buildInteractionResponse(request: InteractionRequestData,
                                         values: InteractionValues): Record<string, unknown> {
  if (request.method === 'session/request_permission') {
    const selected = String(values.permission || '')
    return selected ? { outcome: { outcome: 'selected', option_id: selected } }
      : { outcome: { outcome: 'cancelled' } }
  }
  return { action: 'accept', content: values }
}

export function cancelInteractionResponse(request: InteractionRequestData): Record<string, unknown> {
  return request.method === 'session/request_permission'
    ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' }
}
