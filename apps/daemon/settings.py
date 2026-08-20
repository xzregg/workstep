"""Global settings via pydantic-settings."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """WorkStep Daemon configuration."""

    host: str = "0.0.0.0"
    port: int = 8765
    web_dist: str = "../web/dist"  # React build output
    landing_dist: str = "../landing/dist"  # 官网 landing build output (served at home "/")
    workstep_dir: str = ".workstep"  # Per-project directory name

    model_config = {"env_prefix": "WORKSTEP_"}


settings = Settings()
