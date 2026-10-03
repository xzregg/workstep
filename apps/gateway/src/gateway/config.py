from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from workstep_gateway_protocol.origin import is_loopback_hostname, validate_gateway_origin


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
        return validate_gateway_origin(value.removesuffix("/"))

    @property
    def cookie_secure(self) -> bool:
        return not self.public_origin or urlsplit(self.public_origin).scheme == "https"

    def device_authority(self, device_id: str) -> str:
        if not self.public_origin:
            raise ValueError("Public Gateway origin is not configured")
        parsed = urlsplit(self.public_origin)
        host = parsed.hostname
        if is_loopback_hostname(host) and host != "localhost" and not host.endswith(".localhost"):
            host = "localhost"
        return f"d-{device_id}.{host}" + (f":{parsed.port}" if parsed.port else "")

    def device_url(self, device_id: str) -> str:
        return f"{urlsplit(self.public_origin).scheme}://{self.device_authority(device_id)}/"

    def is_device_authority(self, authority: str) -> bool:
        expected = self.device_authority("placeholder")
        suffix = expected.removeprefix("d-placeholder")
        return authority.startswith("d-") and authority.endswith(suffix)

    @property
    def effective_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite+aiosqlite:///{self.data_dir / 'workstep_platform.db'}"
