from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class GatewaySettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WORKSTEP_GATEWAY_")

    host: str = "127.0.0.1"
    port: int = Field(default=8766, ge=1, le=65535)
    data_dir: Path = Path.home() / ".workstep-gateway"
    web_dist: Path | None = None
    database_url: str | None = None
    directory_reconcile_seconds: int = Field(default=21600, ge=60)
    gateway_id: str = Field(default="local-development", min_length=1)
    public_origin: str | None = None

    @field_validator("public_origin")
    @classmethod
    def valid_public_origin(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or parsed.path not in ("", "/") or parsed.query
                or parsed.fragment or parsed.port is not None):
            raise ValueError("public_origin must be an HTTPS origin without a port")
        return f"https://{parsed.hostname}"

    @property
    def effective_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite+aiosqlite:///{self.data_dir / 'workstep_platform.db'}"
