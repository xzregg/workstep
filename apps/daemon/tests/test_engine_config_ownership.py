"""Engine-owned settings operate on an injected store without a registry."""
import pytest
import subprocess
import sys
from pathlib import Path


def test_configuration_imports_do_not_discover_or_load_engine_adapters():
    result = subprocess.run([
        sys.executable, "-c",
        "import sys; import services.config; import engines._config.claude; "
        "import engines._config.codex; "
        "assert 'engines.core.registry' not in sys.modules; "
        "assert 'engines.codex_sdk' not in sys.modules",
    ], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_codex_settings_use_generic_storage_and_keep_legacy_sections():
    from engines._config.codex import get_codex_sdk_config, set_codex_sdk_config

    class Store:
        def __init__(self):
            self.values = {"unrelated": {"keep": True}}

        def get(self, key, default=None):
            return self.values.get(key, default)

        def set(self, key, value):
            self.values[key] = value

    store = Store()
    set_codex_sdk_config(store, model_reasoning_effort="none", sandbox="read-only")
    assert get_codex_sdk_config(store)["model_reasoning_effort"] == "none"
    assert store.values["codex_sdk_engine"]["sandbox"] == "read-only"
    assert store.values["unrelated"] == {"keep": True}
    with pytest.raises(ValueError, match="不支持的推理强度"):
        set_codex_sdk_config(store, model_reasoning_effort="invalid")
    store.values["engine_models"] = {"codex_sdk": {"models": [{
        "id": "official-new", "is_default": True,
        "supported_reasoning_efforts": ["new-native-effort"],
    }]}}
    set_codex_sdk_config(store, model_reasoning_effort="new-native-effort")
    assert get_codex_sdk_config(store)["model_reasoning_effort"] == "new-native-effort"
    from engines._config.codex import resolve_codex_thinking_effort
    assert resolve_codex_thinking_effort("new-native-effort") == "new-native-effort"
    assert resolve_codex_thinking_effort("auto", "high") is None
