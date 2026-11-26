const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** Conservative local endpoint guard. Punctuation added by ASR is not evidence. */
export function completePhoneTurn(text: string) {
  const value = text.trim().replace(/[\p{P}\s~～]+$/gu, '').replace(/[嗯啊呃额唔]+$/u, '').trimEnd()
  if (!words(value) || /^[嗯啊呃额唔哦噢]+$/u.test(words(value))) return false
  if (/(?:我想|我要|我觉得|我认为|帮我|请帮我|关于|如果|因为|所以|但是|然后|然后呢|还有|以及|比如|就是|那个|这个|让我想想)$/u.test(value)) return false
  if (/^(?:我想|我要|帮我|请帮我)?(?:查一下|看一下)$/u.test(value)) return false
  if (/^(?:我想|我要|我需要|帮我|请帮我|麻烦你)(?:先|再|帮我)?(?:说|说一下|问|问一下|查|检查|找|搜索|打开|关闭|创建|新建|修改|删除|设置|把|将|给)?$/u.test(value)) return false
  if (/^(?:我|你|他|她|它|我们|你们|这个|那个|帮|请|因为|所以|然后)$/u.test(value)) return false
  if (/\b(?:and|or|but|because|if|with|to|the|a|my|please|help me|i want)\s*$/iu.test(value)) return false
  return /[\p{L}\p{N}]/u.test(value)
}

/** Strip recognized playback spans before deciding whether the user spoke. */
export function withoutPlaybackEcho(text: string, reference: string) {
  const source = words(reference)
  if (!source) return ''
  if (source.includes(words(text))) return ''
  // Remove leading echo only. Once novel user speech begins, shared objects
  // (e.g. “明天的天气”) are user content and must not be erased from a request.
  let rest = text
  while (rest) {
    const characters = Array.from(rest), positions: number[] = []
    let normalized = ''
    characters.forEach((character, index) => {
      const value = words(character)
      if (value) {
        normalized += value
        for (let unit = 0; unit < value.length; unit++) positions.push(index)
      }
    })
    if (source.includes(normalized)) return ''
    let low = 0, high = normalized.length
    while (low < high) {
      const length = Math.ceil((low + high) / 2)
      if (source.includes(normalized.slice(0, length))) low = length
      else high = length - 1
    }
    if (low < 4) break
    rest = characters.slice(positions[low - 1] + 1).join('')
  }
  rest = rest.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')
  return (words(rest).length >= 2 || rest === '停') && !/^[嗯啊呃额唔哦噢]+$/u.test(words(rest)) ? rest : ''
}
