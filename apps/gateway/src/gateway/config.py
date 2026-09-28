from pathlib import Path

from pydantic import Field
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

    @property
    def effective_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite+aiosqlite:///{self.data_dir / 'workstep_platform.db'}"
