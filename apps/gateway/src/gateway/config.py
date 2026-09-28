from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class GatewaySettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WORKSTEP_GATEWAY_")

    host: str = "127.0.0.1"
    port: int = Field(default=8766, ge=1, le=65535)
    data_dir: Path = Path.home() / ".workstep-gateway"
    web_dist: Path | None = None
