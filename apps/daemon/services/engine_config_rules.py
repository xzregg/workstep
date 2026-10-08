"""Pure validation and serialization rules for engine configuration."""

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

CODEX_SANDBOX_MODES = {"read-only", "workspace-write", "danger-full-access"}
# Native Codex SDK ReasoningEffort values, in display order. "auto" is only
# WorkStep's sentinel for omitting the override; it is never sent to Codex.
CODEX_REASONING_EFFORTS = (
    "auto", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
)
CODEX_APPROVAL_POLICIES = {"never", "on-failure", "on-request", "full-auto"}
CODEX_SDK_APPROVAL_MODES = {"auto_review", "deny_all"}

QODER_PERMISSION_MODES = {
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
    "auto",
}

OPENCODE_PERMISSION_MODES = {
    "ask",
    "allow",
    "deny",
}

PROVIDER_PROTOCOLS = {
    "anthropic_messages",
    "openai_responses",
    "openai_chat_completions",
}

# Claude Code 内部的四个模型档位。CLI 用 ANTHROPIC_DEFAULT_{档位}_MODEL 解析
# `--model sonnet` 这类档位名，绑定第三方中转后必须把它们映射到真实模型 id。
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
