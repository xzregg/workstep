"""Pinned local TTS resources; each family declares its own runtime and controls."""

import json
import platform
import sys
from pathlib import Path

_MODEL_FILES = json.loads(Path(__file__).with_name("tts_model_files.json").read_text(encoding="utf-8"))

DEFAULT_LOCAL_MODEL = 'moss-nano'
DEFAULT_LOCAL_VOICE = 'Xiaoyu'
LOCAL_MODELS = ('moss-nano', 'cosyvoice3', 'omnivoice')
OMNI_TONES = ('neutral', 'warm', 'happy', 'whisper')
OMNI_PERSONA_VOICE = 'persona'
OMNI_DESIGN_ATTRIBUTES = {
    'gender': {'female': '女性', 'male': '男性'},
    'age': {'child': '儿童', 'teenager': '少年', 'young adult': '青年', 'middle-aged': '中年', 'elderly': '老年'},
    'pitch': {'very low pitch': '极低音调', 'low pitch': '低音调', 'moderate pitch': '中音调',
              'high pitch': '高音调', 'very high pitch': '极高音调'},
    'style': {'whisper': '耳语'},
    'accent': {f'{name} accent': label for name, label in (
        ('american', '美式口音'), ('british', '英式口音'), ('australian', '澳式口音'), ('canadian', '加拿大口音'),
        ('indian', '印度口音'), ('chinese', '中式口音'), ('korean', '韩式口音'), ('japanese', '日式口音'),
        ('portuguese', '葡式口音'), ('russian', '俄式口音'))},
    'dialect': {name: name for name in (
        '河南话', '陕西话', '四川话', '贵州话', '云南话', '桂林话', '济南话', '石家庄话', '甘肃话', '宁夏话', '青岛话', '东北话')},
}
REFERENCE_VOICE = dict(id='reference', name='参考音频')
MOSS_VOICES = [
    dict(id=voice, name=f'{voice} · {group}', group=group)
    for group, names in (
        ('中文女声', 'Xiaoyu Yuewen Lingyu'), ('中文男声', 'Junhao Zhiming Weiguo'),
        ('英文女声', 'Ava Bella'), ('英文男声', 'Adam Nathan Trump'),
        ('日语女声', 'Soyo Saki Mortis Umiri Mei Anon Arisa'),
    ) for voice in names.split()
]
MOSS_REPO = 'OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX'
MOSS_CODEC = 'MOSS-Audio-Tokenizer-Nano-ONNX'
APPLE_SILICON = sys.platform == 'darwin' and platform.machine() == 'arm64'

MODELS = {
    'moss-nano': dict(name='MOSS-TTS-Nano ONNX', repo=MOSS_REPO,
        revision='f52645cb467506d8e18e746ddd59482685b74e58', runtime='moss',
        requirements='ONNX Runtime CPU', reference=True),
    'cosyvoice3': dict(name='CosyVoice3 FP16 · 原生 MLX', repo='mlx-community/Fun-CosyVoice3-0.5B-2512-fp16',
        revision='18ccb7fbd7246e8cd3420d02f5dd28595cc0fcd9', runtime='cosyvoice3',
        instructions=True, style='instruction', reference=True, requirements='Apple Silicon Mac · SGLang Omni MLX'),
    'omnivoice': dict(name='OmniVoice INT8', repo='aufklarer/OmniVoice-MLX-int8',
        revision='e815dfafaf9c90f995ddc9fcfe52fd0d80babe4e', runtime='omnivoice',
        instructions=True, style='tone', reference=True, requirements='Apple Silicon Mac · MLX'),
    'kokoro-v1': dict(name='Kokoro 82M v1.0', repo='csukuangfj/kokoro-multi-lang-v1_0',
        revision='f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b', speakers=53),
    'kokoro-v11': dict(name='Kokoro 82M v1.1 中英版', repo='csukuangfj/kokoro-multi-lang-v1_1',
        revision='423bfb9ccd6a66115a76602a9630ffea265ae176', speakers=103),
}
QWEN_VOICES = [dict(id=key, name=name) for key, name in [
    ('Vivian', 'Vivian 明亮女声'), ('Serena', 'Serena 温柔女声'),
    ('Uncle_Fu', 'Uncle Fu 沉稳男声'), ('Dylan', 'Dylan 北京男声'),
    ('Eric', 'Eric 四川男声'), ('Ryan', 'Ryan 英语男声'),
    ('Aiden', 'Aiden 美式男声'), ('Ono_Anna', 'Anna 日语女声'), ('Sohee', 'Sohee 韩语女声'),
]]
for key, variant, revision, instructions in [
    ('qwen-06-custom', '0.6B-CustomVoice', '85e237c12c027371202489a0ec509ded67b5e4b5', False),
    ('qwen-17-custom', '1.7B-CustomVoice', '0c0e3051f131929182e2c023b9537f8b1c68adfe', True),
    ('qwen-17-design', '1.7B-VoiceDesign', '5ecdb67327fd37bb2e042aab12ff7391903235d3', True),
]:
    MODELS[key] = dict(name=f'Qwen3-TTS {variant}', repo=f'Qwen/Qwen3-TTS-12Hz-{variant}',
        revision=revision, runtime='qwen', instructions=instructions,
        voice_design=variant.endswith('VoiceDesign'),
        requirements='macOS / Windows / Linux，独立 Python 3.12；CPU 可运行但较慢，建议至少 16 GiB 内存')

for spec in MODELS.values():
    spec['files'] = _MODEL_FILES[spec['revision']]
    spec['model_bytes'] = sum(size for _, size, _, _ in spec['files'])
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
    if model_id == 'moss-nano':
        return [*MOSS_VOICES, REFERENCE_VOICE]
    if model_id == 'cosyvoice3':
        return [dict(id='default', name='默认音色'), REFERENCE_VOICE]
    if model_id == 'omnivoice':
        return [dict(id=OMNI_PERSONA_VOICE, name='跟随数字人设定'), REFERENCE_VOICE]
    if MODELS[model_id]['runtime'] == 'qwen':
        return [dict(id='design', name='按描述设计音色')] if MODELS[model_id]['voice_design'] else QWEN_VOICES
    if model_id == 'kokoro-v1':
        return VOICES
    # This checkpoint has a different speaker order; never reuse v1.0 IDs.
    return [dict(id=str(i), name=f'Voice {i + 1}') for i in range(MODELS[model_id]['speakers'])]


def file_source(model_id, name):
    spec = MODELS[model_id]
    if model_id == 'moss-nano' and name.startswith(f'{MOSS_CODEC}/'):
        return f'OpenMOSS-Team/{MOSS_CODEC}', 'ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae', name.split('/', 1)[1]
    if model_id == 'moss-nano':
        return spec['repo'], spec['revision'], name.split('/', 1)[1]
    if model_id == 'cosyvoice3' and name.startswith('speech_tokenizer/'):
        return 'mlx-community/S3TokenizerV3', 'b143914b3e912278104824da706edc9c2d317c4e', name.split('/', 1)[1]
    return spec['repo'], spec['revision'], name


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
