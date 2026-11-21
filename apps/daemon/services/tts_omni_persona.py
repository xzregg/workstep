"""Build local voice delivery instructions from the digital-person profile."""
import re

from services.digital_person import get_profile
from services.tts_catalog import OMNI_DESIGN_ATTRIBUTES

_GENDER = re.compile(r'女声|女性|女孩子|女孩|女士|男声|男性|男孩子|男孩|男士|\b(?:female|woman|male|man)\b', re.I)
_AGE = re.compile(r'中年|年长|老年|年轻|年輕|\b(?:middle[- ]aged|elderly|young adult)\b', re.I)
_DELIVERY = (
    ('whisper', re.compile(r'耳语|耳語|气声|氣聲|悄悄|\bwhisper\w*\b', re.I)),
    ('low pitch', re.compile(r'低音|低声线|低聲線|低沉|\blow pitch\b', re.I)),
    ('high pitch', re.compile(r'高音|高声线|高聲線|清亮|\bhigh pitch\b', re.I)),
    ('low pitch', re.compile(r'温柔|溫柔|柔和|沉稳|沉穩|安抚|\b(?:gentle|calm|warm|soothing)\b', re.I)),
    ('high pitch', re.compile(r'活泼|活潑|俏皮|明快|开朗|開朗|\b(?:playful|lively|bright|cheerful)\b', re.I)),
)
_TONE = {'neutral': '', 'warm': 'low pitch', 'happy': 'high pitch', 'whisper': 'whisper'}
REFERENCE_PROMPT_PREFIX = 'prompt:'
_DESIGN_TERMS = {
    term: (group, identifier)
    for group, values in OMNI_DESIGN_ATTRIBUTES.items()
    for identifier, label in values.items()
    for term in (identifier, label)
}
_DESIGN_TERMS.update({'女': ('gender', 'female'), '男': ('gender', 'male')})


def design_attributes(prompt, text, *, cloning=False):
    """Compose one supported value per group for no-reference synthesis."""
    resolved = {}
    terms = re.split(r'[,，;；\n]+', prompt.lower())
    for part in (term.strip() for term in terms if term.strip()):
        field = _DESIGN_TERMS.get(part)
        if field is None:
            tone = part if part in _TONE else prompted_tone(part)
            if tone is None:
                raise ValueError('OmniVoice 无法识别这段试听提示词。请选择属性标签，或填写自然、温柔、明快、耳语等语气。')
            value = _TONE[tone]
            if not value:
                continue
            field = ('style' if value == 'whisper' else 'pitch', value)
        name, value = field
        if cloning and name not in ('pitch', 'style'):
            raise ValueError('参考音频模式可组合音高和说话方式。')
        if name in resolved and resolved[name] != value:
            raise ValueError('OmniVoice 的同一组声音属性只能选择一项。')
        resolved[name] = value
    if 'accent' in resolved and re.search(r'[\u3400-\u9fff]', text):
        raise ValueError('英语口音请搭配英文试听文本。')
    if 'dialect' in resolved and not re.search(r'[\u3400-\u9fff]', text):
        raise ValueError('中文方言请搭配中文试听文本。')
    if not cloning:
        resolved.setdefault('gender', 'female')
        resolved.setdefault('age', 'young adult')
    return ', '.join(resolved[group] for group in ('gender', 'age', 'pitch', 'style', 'accent', 'dialect') if group in resolved)


def reference_tone(instructions):
    if not instructions.startswith(REFERENCE_PROMPT_PREFIX):
        return None
    return prompted_tone(instructions.removeprefix(REFERENCE_PROMPT_PREFIX))


def prompted_tone(prompt):
    """Map a written delivery prompt to a supported tone without changing speaker attributes."""
    presets = {'whisper': 'whisper', 'low pitch': 'warm', 'high pitch': 'happy'}
    for tag, pattern in _DELIVERY:
        if pattern.search(prompt):
            return presets[tag]
    if re.search(r'自然|平常|平静|\b(?:natural|neutral)\b', prompt, re.I):
        return 'neutral'
    return None


def persona_attributes(personality, tone, selected_tone=''):
    description = f'{tone}\n{personality}'
    gender = _GENDER.search(description)
    age = _AGE.search(description)
    gender_tag = ('male' if gender and (gender[0].startswith('男') or gender[0].lower() in ('male', 'man'))
                  else 'female')
    age_tag = {
        '中年': 'middle-aged', 'middle aged': 'middle-aged', 'middle-aged': 'middle-aged',
        '年长': 'elderly', '老年': 'elderly', 'elderly': 'elderly',
    }.get(age[0].lower() if age else '', 'young adult')
    delivery = _TONE.get(selected_tone)
    if delivery is None:
        delivery = next((tag for section in (tone, personality) for tag, pattern in _DELIVERY if pattern.search(section)), '')
    return ', '.join(tag for tag in (gender_tag, age_tag, delivery) if tag)


def saved_persona_attributes(selected_tone):
    profile = get_profile()
    return persona_attributes(profile.personality, profile.tone, selected_tone)


def digital_delivery(model, voice, person_id):
    from services.digital_person_affect import read

    profile = get_profile()
    affinity = read(person_id)['affinity'] if person_id else 50
    if model == 'cosyvoice3':
        relationship = ('语气亲切自然，适度拉近交流距离。' if affinity >= 80 else
                        '礼貌、克制，保持适当的交流距离。' if affinity < 30 else '自然友好，保持身份设定的表达方式。')
        traits = (profile.tone.strip()[:220], profile.personality.strip()[:220])
        return '\n'.join(part for part in (*traits, relationship) if part), 1

    tone = (prompted_tone(profile.tone) or prompted_tone(profile.personality) or
            ('warm' if affinity >= 80 else 'neutral'))
    # Swift accepts a single delivery label when cloning; preserve it and vary cadence subtly.
    cadence = 0.96 if affinity >= 80 else 1.04 if affinity < 30 else 1
    if voice == 'reference':
        return tone, cadence
    return persona_attributes(profile.personality, profile.tone, tone), cadence
