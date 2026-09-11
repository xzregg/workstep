"""Engine config schema — backend-defined form templates.

Each engine class exposes a declarative config schema. The settings UI
renders the matching controls (select / text / password / ...) directly from
this JSON, so per-engine configuration stays decoupled from the frontend.
"""

import base64
import mimetypes
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


@dataclass(frozen=True)
class EngineConfigOption:
    value: str
    label: str


@dataclass(frozen=True)
class EngineConfigField:
    key: str
    label: str
    type: str = "text"  # text | password | select | textarea | number | checkbox | model_map
    placeholder: str = ""
    options: tuple[EngineConfigOption, ...] | None = None
    required: bool = False
    help: str = ""
    default: Any = ""
    sensitive: bool = False
    # Select values that require explicit user confirmation before saving
    confirm_values: tuple[str, ...] = ()
    # 结构化编辑类字段（如 model_map）暂不支持阶段级覆盖：阶段表单没有对应控件，
    # 且 merge_config_overrides 会整段替换全局值，语义不可控。
    stage_hidden: bool = False


@dataclass(frozen=True, slots=True)
class EngineImage:
    """One image attachment passed to an engine call.

    ``path`` points to a local file (absolute); ``url`` may be an http(s)
    URL or a data: URL. Exactly one of the two should be set.
    """

    path: str | None = None
    url: str | None = None
    description: str = ""

    @property
    def reference(self) -> str:
        """Human/markdown-usable reference to this image."""
        return self.path or self.url or ""

    def to_data_url(self) -> str:
        """Return an http(s)/data URL usable by multimodal providers."""
        if self.url:
            return self.url
        if not self.path:
            raise ValueError("EngineImage has neither path nor url")
        data = Path(self.path).read_bytes()
        media_type = mimetypes.guess_type(self.path)[0] or "application/octet-stream"
        encoded = base64.b64encode(data).decode("ascii")
        return f"data:{media_type};base64,{encoded}"


def validate_api_base_url(base_url: str) -> str | None:
    """Validate that a provider base URL is a complete HTTP(S) URL."""
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return "API 地址必须是完整的 http:// 或 https:// URL"
    return None
