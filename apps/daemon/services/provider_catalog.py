"""Provider presets, protocol selection, URLs, and validation rules."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import urlparse

from services.config import default_provider_protocol, default_provider_protocols
from services.engine_config_rules import PROVIDER_PROTOCOLS

@dataclass(frozen=True)
class ProviderType:
    id: str
    label: str
    default_base_url: str
    auth: str  # bearer | anthropic | none
    default_protocols: tuple[str, ...]
    supports_balance: bool = False
    help: str = ""

    @property
    def default_protocol(self) -> str:
        """Backward-compatible single protocol (first of the list)."""
        return self.default_protocols[0]


PROVIDER_TYPES: dict[str, ProviderType] = {
    "deepseek": ProviderType(
        id="deepseek",
        label="DeepSeek",
        default_base_url="https://api.deepseek.com/v1",
        auth="bearer",
        default_protocols=("openai_chat_completions",),
        help="DeepSeek 官方 OpenAI-compatible 接口",
    ),
    "moonshot": ProviderType(
        id="moonshot",
        label="Kimi（Moonshot）",
        default_base_url="https://api.moonshot.cn/v1",
        auth="bearer",
        default_protocols=("openai_chat_completions",),
        help="Moonshot Kimi OpenAI-compatible 接口",
    ),
    "openai": ProviderType(
        id="openai",
        label="OpenAI",
        default_base_url="https://api.openai.com/v1",
        auth="bearer",
        default_protocols=("openai_responses", "openai_chat_completions"),
        help="OpenAI 官方接口",
    ),
    "anthropic": ProviderType(
        id="anthropic",
        label="Anthropic",
        default_base_url="https://api.anthropic.com/v1",
        auth="anthropic",
        default_protocols=("anthropic_messages",),
        help="Anthropic Messages API（x-api-key 鉴权）",
    ),
    "ollama": ProviderType(
        id="ollama",
        label="Ollama（本地）",
        default_base_url="http://localhost:11434/v1",
        auth="none",
        default_protocols=("openai_chat_completions",),
        help="本地模型运行器，API Key 可留空",
    ),
    "custom": ProviderType(
        id="custom",
        label="自定义",
        default_base_url="",
        auth="bearer",
        default_protocols=("openai_chat_completions", "openai_responses"),
        help="任意 OpenAI-compatible 或 Anthropic-compatible 接口",
    ),
}

VALID_AUTH_STYLES = {"bearer", "anthropic", "none"}

PROTOCOL_LABELS = {
    "anthropic_messages": "Anthropic Messages",
    "openai_responses": "OpenAI Responses",
    "openai_chat_completions": "OpenAI Chat Completions",
}

def get_type_meta(type_id: str) -> ProviderType | None:
    return PROVIDER_TYPES.get(type_id)


def list_provider_types() -> list[dict]:
    result: list[dict] = []
    for item in PROVIDER_TYPES.values():
        data = asdict(item)
        data["default_protocol"] = item.default_protocol
        result.append(data)
    return result


def mask_api_key(api_key: str) -> str:
    """Mask a secret key, keeping only a short prefix and suffix."""
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "****"
    return f"{api_key[:4]}****{api_key[-4:]}"


def auth_headers(provider: dict, protocol: str | None = None) -> dict[str, str]:
    """Build per-provider auth headers for OpenAI-compatible / Anthropic calls.

    ``protocol`` 指定本次调用使用的线协议（缺省取供应商默认协议）：
    Anthropic 协议用 x-api-key 头，其余用 Bearer。
    """
    provider_type = get_type_meta(str(provider.get("type") or "custom"))
    auth = provider_type.auth if provider_type else "bearer"
    selected = str(protocol or "").strip()
    if not selected:
        selected = (
            normalize_provider_protocols(
                provider.get("protocols") or provider.get("protocol"),
                str(provider.get("type") or "custom"),
            )
            or [""]
        )[0]
    if selected == "anthropic_messages":
        auth = "anthropic"
    elif selected in {"openai_responses", "openai_chat_completions"}:
        auth = "none" if auth == "none" else "bearer"
    api_key = str(provider.get("api_key") or "")
    if auth == "anthropic":
        headers = {"anthropic-version": "2023-06-01", "Accept": "application/json"}
        if api_key:
            headers["x-api-key"] = api_key
        return headers
    if auth == "bearer" and api_key:
        return {"Accept": "application/json", "Authorization": f"Bearer {api_key}"}
    return {"Accept": "application/json"}


def normalize_provider_base_url(base_url: str) -> str:
    """Normalize an API base without guessing or changing its version path."""
    return str(base_url or "").strip().rstrip("/")


def provider_basic_url(provider: dict, protocol: str) -> str:
    """Return the basic URL configured for one protocol, with legacy fallback."""
    mapping = provider.get("protocol_base_urls")
    configured = mapping.get(protocol) if isinstance(mapping, dict) else ""
    return normalize_provider_base_url(
        str(configured or provider.get("base_url") or "")
    )


def provider_runtime_base_url(provider: dict, protocol: str) -> str:
    """Return the configured protocol API base unchanged."""
    return provider_basic_url(provider, protocol)


def provider_endpoint_url(provider: dict, protocol: str, endpoint: str) -> str:
    """Build a direct HTTP endpoint from a protocol-specific basic URL."""
    basic = provider_basic_url(provider, protocol)
    suffix = str(endpoint or "").strip("/")
    return f"{basic}/{suffix}" if suffix else basic


def validate_provider_values(
    *,
    name: str,
    type_id: str,
    base_url: str,
    protocols: list[str] | None = None,
    protocol_base_urls: dict[str, str] | None = None,
) -> str | None:
    """Validate provider form values; return an error message or None."""
    # Import after this catalog is initialized: engines auto-discover providers
    # when their package is imported, and may otherwise see a partial catalog.
    from engines.core.schema import validate_api_base_url

    if not name:
        return "供应商名称不能为空"
    provider_type = get_type_meta(type_id)
    if provider_type is None:
        return "不支持的供应商类型"
    if protocols is not None:
        if not protocols:
            return "至少选择一个供应商协议"
        for value in protocols:
            if value not in PROVIDER_PROTOCOLS:
                return "不支持的供应商协议"
    if protocols and protocol_base_urls is not None:
        for protocol in protocols:
            configured = str(protocol_base_urls.get(protocol) or "").strip()
            if not configured:
                return f"{PROTOCOL_LABELS.get(protocol, protocol)} API 地址不能为空"
            url_error = validate_api_base_url(configured)
            if url_error:
                return f"{PROTOCOL_LABELS.get(protocol, protocol)}：{url_error}"
    else:
        if not base_url:
            return "API 地址不能为空"
        url_error = validate_api_base_url(base_url)
        if url_error:
            return url_error
    return None


def canonical_provider_protocol(value: str) -> str:
    aliases = {
        "messages": "anthropic_messages",
        "anthropic": "anthropic_messages",
        "responses": "openai_responses",
        "chat": "openai_chat_completions",
        "chat_completions": "openai_chat_completions",
        "openai-completions": "openai_chat_completions",
    }
    raw = str(value or "").strip()
    return aliases.get(raw, raw)


def normalize_provider_protocol(value: str, type_id: str = "custom") -> str:
    normalized = canonical_provider_protocol(value)
    return (
        normalized
        if normalized in PROVIDER_PROTOCOLS
        else default_provider_protocol(type_id)
    )


def normalize_provider_protocols(
    values: Any, type_id: str = "custom"
) -> list[str]:
    """把任意输入规范化为去重、保序的协议列表。

    入参可以是列表、单个字符串或 None（空值回退到该供应商类型的默认
    协议列表）；每个值经 ``normalize_provider_protocol`` 处理别名后去重。
    """
    if values is None:
        raw_items: list[Any] = []
    elif isinstance(values, str):
        raw_items = [values]
    elif isinstance(values, (list, tuple, set)):
        raw_items = list(values)
    else:
        raw_items = [values]
    fallback = (
        list(get_type_meta(type_id).default_protocols)
        if get_type_meta(type_id) is not None
        else default_provider_protocols(type_id)
    )
    result: list[str] = []
    for value in raw_items:
        # 单值语义与 normalize_provider_protocol 一致：非法值回退类型默认。
        normalized = normalize_provider_protocol(str(value), type_id)
        if normalized not in result:
            result.append(normalized)
    return result or fallback


def select_provider_protocol(provider: dict, protocol: str | None = None) -> str:
    """Resolve one declared protocol, rejecting unsupported explicit choices."""
    provider_type = str(provider.get("type") or "custom")
    declared = normalize_provider_protocols(
        provider.get("protocols") or provider.get("protocol"), provider_type
    )
    requested = canonical_provider_protocol(str(protocol or ""))
    if requested:
        if requested not in PROVIDER_PROTOCOLS or requested not in declared:
            raise ValueError("所选协议未在该供应商中配置")
        return requested
    return declared[0]


def detect_provider_type(base_url: str) -> str:
    """Guess the WorkStep provider type from a base URL host."""
    try:
        parsed = urlparse(base_url)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        host, port = "", None
    if "deepseek" in host:
        return "deepseek"
    if "moonshot" in host:
        return "moonshot"
    if "openai" in host:
        return "openai"
    if "anthropic" in host:
        return "anthropic"
    if "ollama" in host or (host in {"localhost", "127.0.0.1"} and port == 11434):
        return "ollama"
    return "custom"
