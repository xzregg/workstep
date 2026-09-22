/**
 * 宽松工具入参解析 — 从 ToolActivity.input 尽力提取目标（文件路径/搜索词）。
 *
 * 不同引擎的工具参数到达方式不同，`input` 可能是：
 * - 完整对象（TOOL_CALL_ARGS 携带的完整 raw_input dict）；
 * - 完整 JSON 字符串（流式 chunk 累加完毕）；
 * - 多个 JSON 片段拼接的字符串（部分 ACP 引擎的 tool_call_update 每次
 *   携带 dict 片段，经后端 `_text` 序列化后前端逐块拼接，整体不可解析）；
 * - 尚未闭合的截断 JSON 字符串（流式中途）。
 *
 * 目标按语义分为两组：
 * - **文件目标**（`fileTarget`）：`path` / `file_path` / `filePath` /
 *   `filename`，用于 read / edit 工具的文件名链接与摘要；
 * - **搜索目标**（`searchTarget`）：`pattern` / `query`，仅用于 search 类
 *   工具摘要。读取/编辑工具的 `pattern` 是过滤关键词而非文件（如
 *   `read_tool_result` 的 `pattern:"fail"`），绝不能混入文件名展示。
 *
 * `targetComplete` 表示提取到的目标值本身是完整可靠的 JSON 字符串值
 * （截断 JSON 里已闭合的 `"path":"..."` 也算），供渲染层决定执行中
 * 是否可以立即显示文件名链接与预览。
 */

export const FILE_TARGET_KEYS = ['path', 'file_path', 'filePath', 'filename'] as const
export const SEARCH_TARGET_KEYS = ['pattern', 'query'] as const
export const TOOL_TARGET_KEYS = [...FILE_TARGET_KEYS, ...SEARCH_TARGET_KEYS] as const

export type ToolTargetInfo = {
  /** 尽力解析出的入参对象（可能来自片段合并）。 */
  record: Record<string, unknown> | null
  /** 文件类目标（path 系键的第一个命中）。 */
  fileTarget: string
  /** 搜索类目标（pattern / query 的第一个命中）。 */
  searchTarget: string
  /** 第一个命中的目标（文件目标优先），供 tooltip 等兜底展示。 */
  target: string
  /** 目标值完整可靠（流式中途显示文件名/预览是安全的）。 */
  targetComplete: boolean
}

const EMPTY: ToolTargetInfo = {
  record: null,
  fileTarget: '',
  searchTarget: '',
  target: '',
  targetComplete: false,
}

function recordFromObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function pickKeys(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function pickFileChangePath(record: Record<string, unknown>): string {
  const changes = record.changes
  if (!Array.isArray(changes)) return ''
  for (const change of changes) {
    if (typeof change === 'string' && change) return change
    const changeRecord = recordFromObject(change)
    if (changeRecord) {
      const path = pickKeys(changeRecord, FILE_TARGET_KEYS)
      if (path) return path
    }
  }
  return ''
}

/**
 * 扫描字符串中所有顶层平衡的 JSON 对象（正确处理字符串内的花括号与
 * 转义），逐个解析后按顺序合并为单个对象。
 */
function parseTopLevelFragments(source: string): Record<string, unknown>[] {
  const fragments: Record<string, unknown>[] = []
  let depth = 0
  let inString = false
  let escape = false
  let start = -1
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) {
          const candidate = source.slice(start, i + 1)
          try {
            const record = recordFromObject(JSON.parse(candidate))
            if (record) fragments.push(record)
          } catch {
            // 片段不完整/非法：跳过，继续扫描下一个。
          }
          start = -1
        }
      }
    }
  }
  return fragments
}

function infoFromRecord(record: Record<string, unknown> | null): ToolTargetInfo {
  const fileTarget = record
    ? pickKeys(record, FILE_TARGET_KEYS) || pickFileChangePath(record)
    : ''
  const searchTarget = record ? pickKeys(record, SEARCH_TARGET_KEYS) : ''
  return {
    record,
    fileTarget,
    searchTarget,
    target: fileTarget || searchTarget,
    targetComplete: Boolean(fileTarget || searchTarget),
  }
}

/** 截断 JSON 中已闭合的目标字符串，如 `"path":"apps/web/src/…`。 */
const QUOTED_TARGET = new RegExp(
  `"(${TOOL_TARGET_KEYS.join('|')})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
)

export function extractToolTarget(input: unknown): ToolTargetInfo {
  if (input === undefined || input === null) return EMPTY

  if (typeof input === 'object') {
    const record = recordFromObject(input)
    if (!record) return EMPTY
    return infoFromRecord(record)
  }

  if (typeof input !== 'string' || !input.trim()) return EMPTY

  // 1) 完整 JSON 对象
  try {
    const record = recordFromObject(JSON.parse(input))
    if (record) return infoFromRecord(record)
  } catch {
    // 落回片段合并 / 正则提取。
  }

  // 2) 多个 JSON 片段拼接：逐段解析后合并。
  const fragments = parseTopLevelFragments(input)
  if (fragments.length > 0) {
    const merged: Record<string, unknown> = {}
    for (const fragment of fragments) Object.assign(merged, fragment)
    return infoFromRecord(merged)
  }

  // 3) 尾部截断的 JSON：目标字符串可能已闭合。
  const match = QUOTED_TARGET.exec(input)
  if (match) {
    try {
      const decoded = JSON.parse(`"${match[2]}"`)
      const record = { [match[1]]: decoded }
      return infoFromRecord(record)
    } catch {
      return EMPTY
    }
  }
  return EMPTY
}
