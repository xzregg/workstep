import asyncio
import os
from pathlib import Path

from .managed_config import InvalidManagedGatewayConfig, load_managed_config
from .identity import ManagedAuthorizationVerifier, ManagedLocalSessions
from .control import GatewayControlClient
from .policy import ManagedPolicyCache
from services.config import config_store
from services import config as config_module
from .usage_outbox import UsageOutbox
from .usage import build_usage_event


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
        self.usage_outbox = None
        self.device_id = None
        self.current_user_id = None

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
            self.usage_outbox = UsageOutbox(config_module.CONFIG_DIR / "usage-outbox.db")
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
        self.device_id = actor.device_id
        self.current_user_id = actor.user_id
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
            usage_outbox=self.usage_outbox,
        )
        self.control_client.start(
            authorization, actor.device_id, control_private_key_pem,
            control_public_key_pem, delegation_signature,
        )
        return self.local_sessions.create(actor), actor

    async def record_message_usage(self, *, project_id: str | None,
                                   task_id: str | None, message_id: str,
                                   run_id: str | None, model: str | None,
                                   occurred_at, provider: dict | None,
                                   provider_id: str | None,
                                   usage_json: str | None,
                                   user_id: str | None,
                                   session_id: str | None = None) -> None:
        if self.managed_config is None or self.usage_outbox is None or not self.device_id:
            return
        event = build_usage_event(
            gateway_id=self.managed_config.gateway_id, device_id=self.device_id,
            user_id=user_id or self.current_user_id, project_id=project_id,
            task_id=task_id, message_id=message_id, run_id=run_id,
            model=model, occurred_at=occurred_at, provider=provider,
            provider_id=provider_id, usage_json=usage_json,
            initiated_by_user_id=user_id, session_id=session_id,
        )
        await asyncio.to_thread(self.usage_outbox.append, event)

    async def close(self) -> None:
        if self.control_client is not None:
            await self.control_client.stop()
            self.control_client = None
        self.policy_cache.clear()
        self.local_sessions.clear()
        self.device_id = None
        self.current_user_id = None
        config_store.set_managed_gateway_id(None)
