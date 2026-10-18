"""codex configuration rules and legacy storage compatibility."""

from typing import Any

CODEX_SANDBOX_MODES = {"read-only", "workspace-write", "danger-full-access"}
CODEX_SANDBOX_LABELS = {
    "read-only": "只读",
    "workspace-write": "工作区可写",
    "danger-full-access": "完全访问",
}

# Protocol values, not the supported efforts of every model. "auto" omits
# the override and is never sent to Codex.
CODEX_REASONING_EFFORTS = (
    "auto", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
)

CODEX_REASONING_EFFORT_LABELS = {
    "auto": "自动",
    "none": "关闭",
    "minimal": "极简",
    "low": "低",
    "medium": "中",
    "high": "高",
    "xhigh": "极高",
    "max": "最高",
    "ultra": "超高",
}

CODEX_APPROVAL_POLICIES = {"never", "on-failure", "on-request", "full-auto"}
CODEX_APPROVAL_LABELS = {
    "never": "从不请求审批",
    "on-failure": "执行失败时审批",
    "on-request": "按需审批",
    "full-auto": "全自动",
}

CODEX_SDK_APPROVAL_MODES = {"auto_review", "deny_all"}
CODEX_SDK_APPROVAL_LABELS = {
    "auto_review": "自动审批",
    "deny_all": "拒绝所有工具调用",
}


def codex_model_efforts(model: Any) -> list[str] | None:
    """Preserve CLI catalog / SDK model-list effort order without guessing."""
    if isinstance(model, dict):
        options = model.get("supported_reasoning_levels")
    else:
        options = getattr(model, "supported_reasoning_efforts", None)
    if options is None:
        return None
    result = []
    for option in options:
        value = (option.get("effort") if isinstance(option, dict)
                 else getattr(option, "reasoning_effort", None))
        value = getattr(value, "value", value)
        if isinstance(value, str) and value and value not in result:
            result.append(value)
    return result


def resolve_codex_thinking_effort(value: str | None, default: str | None = None) -> str | None:
    """Pass native values through; the model catalog owns available efforts."""
    effort = (value or default or "").strip()
    return None if not effort or effort == "auto" else effort


def _valid_effort(store, engine_id: str, effort: str) -> bool:
    if not effort or effort in CODEX_REASONING_EFFORTS:
        return True
    defaults = store.get("engine_default_models", {})
    model = defaults.get(engine_id, "") if isinstance(defaults, dict) else ""
    caches = store.get("engine_models", {})
    catalog = caches.get(engine_id, {}) if isinstance(caches, dict) else {}
    return any(
        effort in (item.get("supported_reasoning_efforts") or [])
        for item in catalog.get("models", [])
        if (item.get("id") == model if model else item.get("is_default"))
    )


def normalize_codex_custom_config(raw: Any) -> str:
    """校验 Codex 自定义 config 覆盖并返回要存储的文本。

    Codex 的配置不是 JSON，而是 ``key=value`` 形式（对应 CLI 的 ``-c``）。
    接受多行文本；空行与 ``#`` 注释行忽略。只校验、不格式化，原样保留
    用户输入的空格与换行。
    """
    if raw is None:
        return ""
    text = str(raw)
    if not text.strip():
        return ""
    for index, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise ValueError(f"第 {index} 行不是 key=value 格式")
        key, _value = stripped.split("=", 1)
        if not key.strip():
            raise ValueError(f"第 {index} 行缺少配置键")
    return text


def parse_codex_custom_config(raw: Any) -> list[tuple[str, str]]:
    """把自定义覆盖解析为 ``[(key, value), ...]``；无配置返回空列表。"""
    normalized = normalize_codex_custom_config(raw)
    entries: list[tuple[str, str]] = []
    if not normalized:
        return entries
    for line in normalized.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, value = stripped.split("=", 1)
        entries.append((key.strip(), value.strip()))
    return entries


def get_codex_config(store) -> dict[str, str]:
    raw = store.get("codex_engine", {})
    if not isinstance(raw, dict):
        raw = {}
    return {
        "sandbox_mode": raw.get("sandbox_mode", "workspace-write"),
        "model_reasoning_effort": raw.get("model_reasoning_effort", ""),
        "approval_policy": raw.get("approval_policy", ""),
        "custom_config": normalize_codex_custom_config(
            raw.get("custom_config")
        ),
    }


def set_codex_config(
    store,
    sandbox_mode: str = "",
    model_reasoning_effort: str = "",
    approval_policy: str = "",
    custom_config: str = "",
) -> None:
    sandbox_mode = str(sandbox_mode or "").strip() or "workspace-write"
    if sandbox_mode not in CODEX_SANDBOX_MODES:
        raise ValueError("不支持的沙箱模式")
    effort = str(model_reasoning_effort or "").strip()
    if not _valid_effort(store, "codex", effort):
        raise ValueError("不支持的推理强度")
    policy = str(approval_policy or "").strip()
    if policy and policy not in CODEX_APPROVAL_POLICIES:
        raise ValueError("不支持的审批策略")
    custom = normalize_codex_custom_config(custom_config)
    store.set("codex_engine", {
        "sandbox_mode": sandbox_mode,
        "model_reasoning_effort": effort,
        "approval_policy": policy,
        "custom_config": custom,
    })


def get_codex_sdk_config(store) -> dict[str, str]:
    raw = store.get("codex_sdk_engine", {})
    if not isinstance(raw, dict):
        raw = {}
    return {
        "model_reasoning_effort": raw.get("model_reasoning_effort", ""),
        "approval_mode": raw.get("approval_mode", ""),
        "sandbox": raw.get("sandbox", "workspace-write"),
        "custom_config": normalize_codex_custom_config(
            raw.get("custom_config")
        ),
    }


def set_codex_sdk_config(
    store,
    model_reasoning_effort: str = "",
    approval_mode: str = "",
    sandbox: str = "",
    custom_config: str = "",
) -> None:
    effort = str(model_reasoning_effort or "").strip()
    if not _valid_effort(store, "codex_sdk", effort):
        raise ValueError("不支持的推理强度")
    mode = str(approval_mode or "").strip()
    if mode and mode not in CODEX_SDK_APPROVAL_MODES:
        raise ValueError("不支持的审批模式")
    sandbox = str(sandbox or "").strip() or "workspace-write"
    if sandbox not in CODEX_SANDBOX_MODES:
        raise ValueError("不支持的沙箱模式")
    custom = normalize_codex_custom_config(custom_config)
    store.set("codex_sdk_engine", {
        "model_reasoning_effort": effort,
        "approval_mode": mode,
        "sandbox": sandbox,
        "custom_config": custom,
    })
