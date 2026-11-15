"""Pinned local TTS resources; each family declares its own runtime and controls."""

MODELS = {
    'kokoro-v1': dict(name='Kokoro 82M v1.0', repo='csukuangfj/kokoro-multi-lang-v1_0',
        revision='f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b', speakers=53, model_bytes=380000000),
    'kokoro-v11': dict(name='Kokoro 82M v1.1 中英版', repo='csukuangfj/kokoro-multi-lang-v1_1',
        revision='423bfb9ccd6a66115a76602a9630ffea265ae176', speakers=103, model_bytes=406000000),
}
QWEN_VOICES = [dict(id=key, name=name) for key, name in [
    ('Vivian', 'Vivian 明亮女声'), ('Serena', 'Serena 温柔女声'),
    ('Uncle_Fu', 'Uncle Fu 沉稳男声'), ('Dylan', 'Dylan 北京男声'),
    ('Eric', 'Eric 四川男声'), ('Ryan', 'Ryan 英语男声'),
    ('Aiden', 'Aiden 美式男声'), ('Ono_Anna', 'Anna 日语女声'), ('Sohee', 'Sohee 韩语女声'),
]]
for key, variant, revision, size, instructions in [
    ('qwen-06-custom', '0.6B-CustomVoice', '85e237c12c027371202489a0ec509ded67b5e4b5', 2490000000, False),
    ('qwen-17-custom', '1.7B-CustomVoice', '0c0e3051f131929182e2c023b9537f8b1c68adfe', 4520000000, True),
    ('qwen-17-design', '1.7B-VoiceDesign', '5ecdb67327fd37bb2e042aab12ff7391903235d3', 4520000000, True),
]:
    MODELS[key] = dict(name=f'Qwen3-TTS {variant}', repo=f'Qwen/Qwen3-TTS-12Hz-{variant}',
        revision=revision, model_bytes=size, runtime='qwen', instructions=instructions,
        voice_design=variant.endswith('VoiceDesign'),
        requirements='macOS / Windows / Linux，独立 Python 3.12；CPU 可运行但较慢，建议至少 16 GiB 内存')

for spec in MODELS.values():
    spec.setdefault('runtime', 'sherpa')
    spec.setdefault('instructions', False)
    spec.setdefault('voice_design', False)
    spec.setdefault('requirements', 'macOS / Windows / Linux，CPU，2 线程')
VOICES = [dict(id=str(i), name=name) for i, name in [
    (45, '小贝'), (46, '小妮'), (47, '小小'), (48, '小伊'),
    (49, '云健'), (50, '云希'), (51, '云夏'), (52, '云扬'),
    (3, 'Heart (English)'), (6, 'Nicole (English)'), (16, 'Michael (English)'),
]]


def voices(model_id):
    if MODELS[model_id]['runtime'] == 'qwen':
        return [dict(id='design', name='按描述设计音色')] if MODELS[model_id]['voice_design'] else QWEN_VOICES
    if model_id == 'kokoro-v1':
        return VOICES
    # This checkpoint has a different speaker order; never reuse v1.0 IDs.
    return [dict(id=str(i), name=f'Voice {i + 1}') for i in range(MODELS[model_id]['speakers'])]


PROVIDERS = [
    dict(id='qwen', name='阿里云 Qwen', model='qwen3-tts-flash-realtime', voice='Cherry',
         base_url='', streaming=True, instructions=True),
    dict(id='volcengine', name='火山引擎', model='seed-tts-2.0', voice='zh_female_vv_uranus_bigtts',
         base_url='', streaming=True, instructions=False),
    dict(id='tencent', name='腾讯云', model='1', voice='101001',
         base_url='', streaming=False, instructions=False),
    dict(id='openai', name='OpenAI compatible', model='tts-1', voice='alloy',
         base_url='https://api.openai.com/v1', streaming=True, instructions=False),
    dict(id='voicebox', name='Voicebox', model='0.6B', voice='',
         base_url='http://127.0.0.1:17493', streaming=False, instructions=True),
]
