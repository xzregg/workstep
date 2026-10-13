export const modelPriceFields = [
  ['input_per_million', '输入'], ['output_per_million', '输出'],
  ['cache_read_per_million', '缓存读取'], ['cache_write_per_million', '缓存写入'],
] as const
export type ModelPrices = Partial<Record<typeof modelPriceFields[number][0], string>>
export function ModelPriceFields({ values, onChange, prefix = '' }: {
  values: ModelPrices; onChange: (values: ModelPrices) => void; prefix?: string
}) {
  return <>{modelPriceFields.map(([field, label]) => <label key={field}>{label}
    <input type="text" inputMode="decimal" maxLength={32} aria-label={`${prefix}${label}单价`}
      value={values[field] ?? ''} onChange={event => onChange({ ...values, [field]:event.target.value })}/>
  </label>)}</>
}
