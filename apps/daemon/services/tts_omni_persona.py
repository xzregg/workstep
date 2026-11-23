"""Resolve OmniVoice preset tags and CosyVoice3 delivery instructions."""
import re

from services.digital_person import get_profile
from services.tts_catalog import OMNI_DESIGN_ATTRIBUTES

OMNI_LEGACY_ATTRIBUTES = {'neutral': '', 'warm': 'low pitch', 'happy': 'high pitch', 'whisper': 'whisper'}
ATTRIBUTES_PREFIX = 'attributes:'
_DESIGN_TERMS = {
    term: (group, identifier)
    for group, values in OMNI_DESIGN_ATTRIBUTES.items()
    for identifier, label in values.items()
    for term in (identifier, label)
}


def design_attributes(tags, text=None, *, cloning=False):
    """Compose one supported value per group for OmniVoice synthesis."""
    resolved = {}
    terms = re.split(r'[,，;；\n]+', tags.lower())
    for part in (term.strip() for term in terms if term.strip()):
        field = _DESIGN_TERMS.get(part)
        if field is None:
            raise ValueError('OmniVoice 仅支持声音设置中的预设标签。')
        name, value = field
        if cloning and name not in ('pitch', 'style'):
            raise ValueError('参考音频模式可组合音高和说话方式。')
        if name in resolved and resolved[name] != value:
            raise ValueError('OmniVoice 的同一组声音属性只能选择一项。')
        resolved[name] = value
    if text is not None:
        chinese = re.search(r'[\u3400-\u9fff]', text)
        incompatible = 'accent' if chinese else 'dialect'
        resolved.pop(incompatible, None)
    if not cloning:
        resolved.setdefault('gender', 'female')
        resolved.setdefault('age', 'young adult')
    return ', '.join(resolved[group] for group in ('gender', 'age', 'pitch', 'style', 'accent', 'dialect') if group in resolved)


def cosyvoice_instructions(person_id=None, *, preview=False):
    from services.digital_person_affect import read

    profile = get_profile()
    traits = (profile.tone.strip()[:220], profile.personality.strip()[:220])
    if preview:
        return '\n'.join(filter(None, (profile.role.strip(), profile.personality.strip(), profile.tone.strip())))
    affinity = read(person_id)['affinity'] if person_id else 50
    relationship = ('语气亲切自然，适度拉近交流距离。' if affinity >= 80 else
                    '礼貌、克制，保持适当的交流距离。' if affinity < 30 else '自然友好，保持身份设定的表达方式。')
    return '\n'.join(part for part in (*traits, relationship) if part)
