import asyncio
import os
from pathlib import Path

from .managed_config import InvalidManagedGatewayConfig, load_managed_config
from .identity import ManagedAuthorizationVerifier, ManagedLocalSessions


class GatewayClientService:
    """Lifecycle placeholder for a future, explicitly configured managed client."""

    def __init__(self) -> None:
        self.managed_config = None
        self.verifier = None
        self.local_sessions = ManagedLocalSessions()

    async def start(self) -> None:
        bundle_dir = os.environ.get("WORKSTEP_MANAGED_BUNDLE_DIR")
        root_pin = os.environ.get("WORKSTEP_MANAGED_ROOT_PIN")
        if root_pin and not bundle_dir:
            raise InvalidManagedGatewayConfig("Managed Gateway bundle path is missing")
        self.managed_config = (
            await asyncio.to_thread(
                load_managed_config, Path(bundle_dir), root_pin,
            )
            if bundle_dir else None
        )
        if self.managed_config is not None:
            self.verifier = ManagedAuthorizationVerifier(
                self.managed_config.gateway_id,
                self.managed_config.gateway_origin,
                self.managed_config.gateway_public_key_fingerprint,
            )

    async def bootstrap(self, authorization: str, proof: str):
        if self.managed_config is None or self.verifier is None:
            raise ValueError("Managed Gateway is unavailable")
        actor = await self.verifier.verify(authorization, proof)
        return self.local_sessions.create(actor), actor

    async def close(self) -> None:
        self.local_sessions.clear()
