/**
 * 输出产物类型配置 —— 画布编辑器下拉可选类型。
 * 增删类型只需改此数组，前端打包自动生效。
 */
export const OUTPUT_TYPES = [
  "md",
  "html",
  "json",
  "txt",
  "jpg",
  "png",
  "docx",
  "xlsx",
  "csv",
  "pdf",
] as const

export type OutputType = (typeof OUTPUT_TYPES)[number]

export const DEFAULT_OUTPUT_TYPE: OutputType = "md"
