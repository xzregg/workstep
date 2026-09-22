import json

import pytest

from services.config import claude_model_map_env, normalize_claude_model_map


def test_normalize_claude_model_map_defaults_name_to_model():
    assert normalize_claude_model_map(json.dumps({
        "sonnet": {"model": " qwen3-max ", "name": ""},
        "opus": {"model": "deepseek-v4", "name": "DeepSeek V4"},
        "future": {"model": "ignored"},
        "haiku": {"model": ""},
    })) == {
        "sonnet": {"model": "qwen3-max", "name": "qwen3-max"},
        "opus": {"model": "deepseek-v4", "name": "DeepSeek V4"},
    }


@pytest.mark.parametrize("raw", [
    "not-json",
    "[]",
    '{"sonnet": "qwen3-max"}',
    '{"sonnet": 42}',
])
def test_normalize_claude_model_map_rejects_bad_shapes(raw):
    with pytest.raises(ValueError, match="模型映射格式不正确"):
        normalize_claude_model_map(raw)


def test_normalize_claude_model_map_rejects_overlong_content():
    with pytest.raises(ValueError, match="模型映射内容过长"):
        normalize_claude_model_map({
            "sonnet": {"model": "x" * 257},
        })


def test_claude_model_map_env_only_includes_configured_aliases():
    assert claude_model_map_env({
        "sonnet": {"model": "qwen3-max", "name": "Qwen Max"},
        "haiku": {"model": "", "name": "ignored"},
    }) == {
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen3-max",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Qwen Max",
    }
