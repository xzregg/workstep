"""claude configuration rules and legacy storage compatibility."""

import json
from typing import Any

CLAUDE_PERMISSION_MODES = {
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "manual",
    "dontAsk",
    "plan",
}

CLAUDE_MODEL_MAP_ALIASES = ("fable", "haiku", "opus", "sonnet")

CLAUDE_MODEL_MAP_MAX_LEN = 256


def normalize_claude_model_map(raw: Any) -> dict[str, dict[str, str]]:
    """把任意输入规范化为 ``{档位: {"model": 模型 id, "name": 显示名}}``。

    入参可以是 API 传输层的 JSON 字符串，也可以是存储/cc-switch 的 dict。
    显示名为空时补成模型 id —— 「默认同值」这一语义只在存储层固化一次，
    env 生成、UI 回显和导入预填都直接复用规范化结果。
    """
    if raw is None:
        return {}
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return {}
        try:
            raw = json.loads(text)
        except ValueError:
            raise ValueError("模型映射格式不正确")
    if isinstance(raw, dict) is False:
        raise ValueError("模型映射格式不正确")
    normalized: dict[str, dict[str, str]] = {}
    for alias, entry in raw.items():
        key = str(alias or "").strip().lower()
        if key not in CLAUDE_MODEL_MAP_ALIASES:
            # 未知档位静默丢弃：CLI 新增档位时旧版本不至于保存失败。
            continue
        if not isinstance(entry, dict):
            raise ValueError("模型映射格式不正确")
        model = str(entry.get("model") or "").strip()
        if not model:
            continue
        name = str(entry.get("name") or "").strip() or model
        for value in (model, name):
            if len(value) > CLAUDE_MODEL_MAP_MAX_LEN:
                raise ValueError("模型映射内容过长")
        normalized[key] = {"model": model, "name": name}
    return normalized


def claude_model_map_env(
    model_map: dict[str, dict[str, str]],
) -> dict[str, str]:
    """把规范化后的映射展开为 Claude Code 识别的环境变量。"""
    env: dict[str, str] = {}
    for alias, entry in model_map.items():
        model = str((entry or {}).get("model") or "").strip()
        if not model:
            continue
        prefix = f"ANTHROPIC_DEFAULT_{alias.upper()}_MODEL"
        env[prefix] = model
        env[f"{prefix}_NAME"] = str(entry.get("name") or "").strip() or model
    return env


def claude_sandbox_env(permission_mode: str | None) -> dict[str, str]:
    """Claude Code 在 root 下用 bypassPermissions 需要显式声明沙盒环境。

    CLI 的 ``isRootOutsideDeliberateSandbox()`` 会把「root + 未声明沙盒」判定为
    危险组合并直接 exit 1（``--dangerously-skip-permissions cannot be used with
    root/sudo privileges``）。容器化部署正是 root + 隔离文件系统，注入
    ``IS_SANDBOX=1`` 后 CLI 认可这是刻意沙盒，bypassPermissions 才能生效。
    """
    if str(permission_mode or "").strip() != "bypassPermissions":
        return {}
    return {"IS_SANDBOX": "1"}


def claude_model_map_json(
    model_map: dict[str, dict[str, str]],
) -> str:
    """序列化为稳定的 JSON 字符串（配置快照按字符串全等比较，键序必须固定）。"""
    if not model_map:
        return ""
    return json.dumps(model_map, sort_keys=True, ensure_ascii=False)


def normalize_claude_custom_settings(raw: Any) -> str:
    """校验引擎自定义配置并返回要存储的 JSON 文本。

    接受 JSON 字符串或 dict；必须是对象，``env``（若有）必须是
    ``{字符串: 字符串}``。空输入返回空串，表示不注入任何自定义配置。

    传入字符串时只做校验、不做格式化：原样保留用户输入的空格与换行，
    避免保存后回显被重排。传入 dict（测试或程序化调用）才序列化。
    """
    if raw is None:
        return ""
    original_text: str | None = None
    if isinstance(raw, str):
        original_text = raw
        text = raw.strip()
        if not text:
            return ""
        try:
            raw = json.loads(text)
        except ValueError:
            raise ValueError("自定义配置必须是合法 JSON")
    if isinstance(raw, dict) is False:
        raise ValueError("自定义配置必须是 JSON 对象")
    env = raw.get("env")
    if env is not None:
        if isinstance(env, dict) is False:
            raise ValueError("env 必须是 JSON 对象")
        for key, value in env.items():
            if not isinstance(key, str) or isinstance(value, (dict, list)):
                raise ValueError("env 的值必须是字符串")
    if original_text is not None:
        return original_text
    return json.dumps(raw, sort_keys=True, ensure_ascii=False)


def claude_custom_settings_json(raw: Any) -> str:
    """读取路径的容错版本：存储值非法时返回空串而不抛错。"""
    try:
        return normalize_claude_custom_settings(raw)
    except ValueError:
        return ""


def claude_custom_settings_payload(raw: Any) -> dict[str, Any]:
    """解析自定义配置为 dict；无配置或存储值非法时返回空 dict。"""
    normalized = claude_custom_settings_json(raw)
    return json.loads(normalized) if normalized else {}


def claude_custom_settings_env(
    raw: Any,
    exclude: set[str] | None = None,
) -> dict[str, str]:
    """提取自定义配置里的 ``env``，值统一转为字符串。

    ``exclude`` 用于保护供应商管理的变量：绑定供应商后 base url 与鉴权
    由供应商决定，自定义 JSON 不得覆盖，也不得重新加回供应商显式清理的键
    （例如 ``ANTHROPIC_AUTH_TOKEN``）。
    """
    env = claude_custom_settings_payload(raw).get("env")
    if not isinstance(env, dict):
        return {}
    blocked = exclude or set()
    return {
        str(key): str(value)
        for key, value in env.items()
        if str(key) not in blocked
    }


def claude_custom_settings_rest(raw: Any) -> dict[str, Any]:
    """自定义配置去掉 ``env`` 后的部分，用于合并进 Claude Code settings。"""
    payload = claude_custom_settings_payload(raw)
    payload.pop("env", None)
    return payload


def get_claude_permission_mode(store) -> str:
    mode = store.get("claude_permission_mode", "")
    return mode if mode in CLAUDE_PERMISSION_MODES else ""


def set_claude_permission_mode(store, mode: str):
    if mode not in CLAUDE_PERMISSION_MODES:
        raise ValueError(f"Unsupported Claude permission mode: {mode}")
    store.set("claude_permission_mode", mode)


def get_claude_code_config(store) -> dict[str, str]:
    """Claude Code CLI engine section.

    ``model_map`` 与 ``custom_settings`` 都走传输层字符串（引擎配置表单
    的 value 全是字符串），无内容时为空串。
    """
    raw = store.get("claude_code_engine", {})
    if not isinstance(raw, dict):
        raw = {}
    return {
        "model_map": claude_model_map_json(
            normalize_claude_model_map(raw.get("model_map"))
        ),
        "custom_settings": claude_custom_settings_json(
            raw.get("custom_settings")
        ),
    }


def set_claude_code_model_map(store, model_map: Any) -> None:
    set_claude_code_config(store, model_map=model_map)


def set_claude_code_config(
    store,
    model_map: Any = None,
    custom_settings: Any = None,
) -> None:
    raw = store.get("claude_code_engine", {})
    raw = dict(raw) if isinstance(raw, dict) else {}
    if model_map is not None:
        normalized = normalize_claude_model_map(model_map)
        if normalized:
            raw["model_map"] = normalized
        else:
            raw.pop("model_map", None)
    if custom_settings is not None:
        normalized_settings = normalize_claude_custom_settings(custom_settings)
        if normalized_settings:
            raw["custom_settings"] = normalized_settings
        else:
            raw.pop("custom_settings", None)
    store.set("claude_code_engine", raw)


def get_claude_agent_sdk_config(store) -> dict[str, Any]:
    raw = store.get("claude_agent_sdk_engine", {})
    if not isinstance(raw, dict):
        raw = {}
    max_turns = raw.get("max_turns", "")
    return {
        "permission_mode": get_claude_permission_mode(store),
        "max_turns": str(max_turns) if max_turns not in (None, "") else "",
        "fallback_model": str(raw.get("fallback_model", "") or ""),
        "model_map": claude_model_map_json(
            normalize_claude_model_map(raw.get("model_map"))
        ),
        "custom_settings": claude_custom_settings_json(
            raw.get("custom_settings")
        ),
    }


def set_claude_agent_sdk_config(
    store,
    max_turns: str = "",
    permission_mode: str | None = None,
    fallback_model: str = "",
    model_map: str | dict[str, Any] | None = None,
    custom_settings: str | dict[str, Any] | None = None,
) -> None:
    if permission_mode is not None:
        set_claude_permission_mode(store, permission_mode)
    raw = store.get("claude_agent_sdk_engine", {})
    if not isinstance(raw, dict):
        raw = {}
    raw = dict(raw)
    max_turns = str(max_turns or "").strip()
    if max_turns:
        try:
            value = int(max_turns)
        except ValueError:
            raise ValueError("最大轮数必须是正整数")
        if value <= 0:
            raise ValueError("最大轮数必须是正整数")
        raw["max_turns"] = value
    else:
        raw.pop("max_turns", None)
    fallback_model = str(fallback_model or "").strip()
    if fallback_model:
        raw["fallback_model"] = fallback_model
    else:
        raw.pop("fallback_model", None)
    if model_map is not None:
        # None = 保持原值（部分调用方只改轮数/备用模型）；"" = 显式清空。
        normalized_map = normalize_claude_model_map(model_map)
        if normalized_map:
            raw["model_map"] = normalized_map
        else:
            raw.pop("model_map", None)
    if custom_settings is not None:
        normalized_settings = normalize_claude_custom_settings(custom_settings)
        if normalized_settings:
            raw["custom_settings"] = normalized_settings
        else:
            raw.pop("custom_settings", None)
    store.set("claude_agent_sdk_engine", raw)
