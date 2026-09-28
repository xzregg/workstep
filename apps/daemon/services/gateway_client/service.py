import asyncio
import os
from pathlib import Path

from .managed_config import InvalidManagedGatewayConfig, load_managed_config
from .identity import ManagedAuthorizationVerifier, ManagedLocalSessions
from .control import GatewayControlClient
from .policy import ManagedPolicyCache
from services.config import config_store


class GatewayClientService:
    """Lifecycle placeholder for a future, explicitly configured managed client."""

    def __init__(self, control_client_factory=GatewayControlClient) -> None:
        self.managed_config = None
        self.verifier = None
        self.local_sessions = ManagedLocalSessions()
        self.control_client = None
        self.control_client_factory = control_client_factory
        self.policy_cache = ManagedPolicyCache()
        self.asgi_app = None

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
            config_store.set_managed_gateway_id(
                self.managed_config.gateway_id,
                provider_guard=lambda provider_id: bool(
                    self.policy_cache.current and self.policy_cache.current.valid
                    and config_store.get("managed_provider_state", {}).get("user_id")
                        == self.policy_cache.current.user_id
                    and provider_id in self.policy_cache.current.allowed_provider_ids
                ),
            )
            self.verifier = ManagedAuthorizationVerifier(
                self.managed_config.gateway_id,
                self.managed_config.gateway_origin,
                self.managed_config.gateway_public_key_fingerprint,
            )

    async def bootstrap(self, authorization: str, proof: str, control_private_key_pem: str,
                        control_public_key_pem: str, delegation_signature: str):
        if self.managed_config is None or self.verifier is None:
            raise ValueError("Managed Gateway is unavailable")
        actor = await self.verifier.verify(authorization, proof)
        if self.control_client is not None:
            await self.control_client.stop()
        if self.policy_cache.current and (
                self.policy_cache.current.user_id != actor.user_id
                or self.policy_cache.current.device_id != actor.device_id):
            self.policy_cache.clear()
        self.control_client = self.control_client_factory(
            self.managed_config.gateway_origin,
            gateway_id=self.managed_config.gateway_id,
            public_key_fingerprint=self.managed_config.gateway_public_key_fingerprint,
            user_id=actor.user_id, policy_cache=self.policy_cache,
            asgi_app=self.asgi_app,
            provider_store=config_store,
        )
        self.control_client.start(
            authorization, actor.device_id, control_private_key_pem,
            control_public_key_pem, delegation_signature,
        )
        return self.local_sessions.create(actor), actor

    async def close(self) -> None:
        if self.control_client is not None:
            await self.control_client.stop()
            self.control_client = None
        self.policy_cache.clear()
        self.local_sessions.clear()
        config_store.set_managed_gateway_id(None)
