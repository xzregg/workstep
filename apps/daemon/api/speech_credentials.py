from typing import Literal

from pydantic import BaseModel, Field


class SpeechCredentialRequest(BaseModel):
    mode: Literal['cloud', 'remote']
    provider: str = Field(max_length=80)
    base_url: str = Field(default='', max_length=2000)
    app_id: str = Field(default='', max_length=200)
    region: str | None = Field(default=None, max_length=100)
    field: Literal['api_key', 'secret_id', 'secret_key']
