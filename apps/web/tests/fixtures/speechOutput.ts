import type { OutputStatus } from '../../src/api/speechOutput'

export const outputStatus: OutputStatus = {
  settings: { mode: 'system', provider: 'qwen', model_id: 'kokoro-v1', model: 'qwen3-tts-flash-realtime',
    base_url: '', voice: 'Cherry', rate: 1, volume: 1, instructions: '', region: 'beijing', resource_id: 'seed-tts-2.0', app_id: '', engine: 'qwen' },
  models: [
    { id: 'kokoro-v1', name: 'Kokoro 82M v1.0', model_bytes: 380000000, installed: true,
      voices: [{ id: '45', name: '小贝' }, { id: '46', name: '小妮' }], streaming: 'sentence', license_url: 'https://example.com/license',
      install: { stage: 'installed', downloaded_bytes: 0, total_bytes: null, error: '' } },
    { id: 'kokoro-v11', name: 'Kokoro 82M v1.1', model_bytes: 400000000, installed: false,
      voices: [{ id: '0', name: 'Voice 1' }], streaming: 'sentence', license_url: 'https://example.com/license',
      install: { stage: 'idle', downloaded_bytes: 0, total_bytes: null, error: '' } },
  ],
  service: 'stopped',
  providers: [
    { id: 'qwen', name: '阿里云 Qwen', model: 'qwen3-tts-flash-realtime', voice: 'Cherry', base_url: '', streaming: true, instructions: false },
    { id: 'tencent', name: '腾讯云', model: '1', voice: '101001', base_url: '', streaming: false, instructions: false },
    { id: 'volcengine', name: '火山引擎', model: 'seed-tts-2.0', voice: 'voice', base_url: '', streaming: true, instructions: false },
    { id: 'voicebox', name: 'Voicebox', model: '0.6B', voice: '', base_url: 'http://127.0.0.1:17493', streaming: false, instructions: true },
    { id: 'openai', name: 'OpenAI compatible', model: 'tts-1', voice: 'alloy', base_url: 'https://api.openai.com/v1', streaming: true, instructions: false },
  ],
}


export const qwenOutputModels: OutputStatus['models'] = [
  ['qwen-06-custom', 'Qwen3-TTS 0.6B-CustomVoice', false, false],
  ['qwen-17-custom', 'Qwen3-TTS 1.7B-CustomVoice', true, false],
  ['qwen-17-design', 'Qwen3-TTS 1.7B-VoiceDesign', true, true],
].map(([id, name, instructions, design]) => ({
  ...outputStatus.models[0], id: String(id), name: String(name), runtime: 'qwen',
  model_bytes: id === 'qwen-06-custom' ? 2490000000 : 4520000000,
  instructions: Boolean(instructions), voice_design: Boolean(design),
  voices: design ? [{ id: 'design', name: '按描述设计音色' }] : [{ id: 'Vivian', name: 'Vivian' }, { id: 'Serena', name: 'Serena' }],
}))
