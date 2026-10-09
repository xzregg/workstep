import asyncio
import json
import os
import logging
import httpx
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .managed_config import InvalidManagedGatewayConfig, load_managed_config
from .browser_login import configured_payload
from .identity import ManagedAuthorizationVerifier, ManagedLocalSessions
from .control import GatewayControlClient
from .policy import ManagedPolicyCache
from services.config import config_store
from services import config as config_module
from .usage_outbox import UsageOutbox
from .audit_outbox import ProjectAuditOutbox
from .usage import build_usage_event
from .skill_sync_client import ManagedSkillSyncService
from services.project import project_manager
from .policy import require_managed_capability
from . import connection_credentials


class GatewayClientService:
    """Lifecycle for a package-pinned or user-configured platform connection."""

    def __init__(self, control_client_factory=GatewayControlClient) -> None:
        self.managed_config = None
        self.verifier = None
        self.local_sessions = ManagedLocalSessions()
        self.control_client = None
        self.control_client_factory = control_client_factory
        self.policy_cache = ManagedPolicyCache()
        self.asgi_app = None
        self.usage_outbox = None
        self.audit_outbox = ProjectAuditOutbox(project_manager)
        self.device_id = None
        self.current_user_id = None
        self.current_actor = None
        self.authorization_required = False
        self._restore_task = None
        self.skill_sync = None
        self.workflow_runtime = None

    async def start(self) -> None:
        bundle_dir = os.environ.get("WORKSTEP_MANAGED_BUNDLE_DIR")
        root_pin = os.environ.get("WORKSTEP_MANAGED_ROOT_PIN")
        if root_pin and not bundle_dir:
            raise InvalidManagedGatewayConfig("Managed Gateway bundle path is missing")
        self.managed_config = (
            await asyncio.to_thread(
                load_managed_config, Path(bundle_dir), root_pin,
            )
            if bundle_dir else await asyncio.to_thread(configured_payload)
        )
        if self.managed_config is not None:
            self.usage_outbox = await asyncio.to_thread(
                UsageOutbox, config_module.CONFIG_DIR / "usage-outbox.db",
            )
            config_store.set_managed_gateway_id(
                self.managed_config.gateway_id,
                provider_guard=lambda provider_id: bool(
                    self.policy_cache.current and self.policy_cache.current.valid
                    and config_store.get("managed_provider_state", {}).get("user_id")
                        == self.policy_cache.current.user_id
                    and provider_id in self.policy_cache.current.allowed_provider_ids
                ),
                local_provider_guard=self._local_provider_allowed,
            )
            self.verifier = ManagedAuthorizationVerifier(
                self.managed_config.gateway_id,
                self.managed_config.gateway_origin,
                self.managed_config.gateway_public_key_fingerprint,
            )
            self.skill_sync = ManagedSkillSyncService(
                self.managed_config.gateway_origin,
                project_lookup=project_manager.get_project_by_id,
                is_project_busy=lambda project_id: bool(
                    self.workflow_runtime and
                    self.workflow_runtime.project_has_active_runs(project_id)
                ),
            )
            self._restore_task = asyncio.create_task(self._restore_with_retry())

    def _local_provider_allowed(self) -> bool:
        from services.remote_access import get_current_actor
        actor = get_current_actor()
        policy = self.policy_cache.current
        return bool(policy and policy.allows("provider.local") and (
            actor is None or (actor.source == "managed" and actor.project_id is None
                              and actor.actor_id == policy.user_id)))

    async def _restore_with_retry(self):
        while True:
            try:
                await self.restore_connection()
                return
            except (OSError, ConnectionError, httpx.HTTPError):
                await asyncio.sleep(10)
            except Exception:
                self.authorization_required = True
                logging.getLogger(__name__).warning('Gateway saved connection requires authorization')
                return

    async def restore_connection(self):
        origin = self.managed_config.gateway_origin
        saved = await asyncio.to_thread(connection_credentials.load, origin)
        if not saved:
            self.authorization_required = True
            return
        actor = await self.verifier.verify(saved['authorization'], saved['proof'],
            reconnect_token=saved.get('reconnect_token'), control_public_key_pem=saved['control_public'])
        await self._connect_actor(actor, saved)

    async def _connect_actor(self, actor, saved):
        self.device_id = actor.device_id
        self.current_user_id = actor.user_id
        self.current_actor = actor
        self.authorization_required = False
        if self.control_client is not None:
            await self.control_client.stop()
        self.policy_cache.clear()
        origin = self.managed_config.gateway_origin
        async def persist(token):
            saved['reconnect_token'] = token
            writing = asyncio.create_task(asyncio.to_thread(connection_credentials.save, origin, dict(saved)))
            try:
                await asyncio.shield(writing)
            except asyncio.CancelledError:
                await writing
                raise
        self.control_client = self.control_client_factory(
            origin, gateway_id=self.managed_config.gateway_id,
            public_key_fingerprint=self.managed_config.gateway_public_key_fingerprint,
            user_id=actor.user_id, policy_cache=self.policy_cache, asgi_app=self.asgi_app,
            provider_store=config_store, usage_outbox=self.usage_outbox,
            audit_outbox=self.audit_outbox, skill_sync=self.skill_sync, on_reconnect_token=persist,
        )
        args = (saved['authorization'], actor.device_id, saved['control_private'],
                saved['control_public'], saved['delegation'])
        if saved.get('reconnect_token'):
            self.control_client.start(*args, reconnect_token=saved['reconnect_token'])
        else:
            self.control_client.start(*args)

    async def bootstrap(self, authorization: str, proof: str, control_private_key_pem: str,
                        control_public_key_pem: str, delegation_signature: str):
        if self.managed_config is None or self.verifier is None:
            raise ValueError("Managed Gateway is unavailable")
        actor = await self.verifier.verify(authorization, proof)
        if self._restore_task and self._restore_task is not asyncio.current_task():
            self._restore_task.cancel()
            await asyncio.gather(self._restore_task, return_exceptions=True)
            self._restore_task = None
        saved = dict(authorization=authorization, proof=proof, control_private=control_private_key_pem,
                     control_public=control_public_key_pem, delegation=delegation_signature)
        await asyncio.to_thread(connection_credentials.save, self.managed_config.gateway_origin, saved)
        await self._connect_actor(actor, saved)
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

    async def record_one_shot_usage(self, *, project_id: str | None,
                                    model: str, provider: dict | None,
                                    usage: dict | None) -> None:
        if self.managed_config is None:
            return
        from services.remote_project import get_effective_actor

        actor = await asyncio.to_thread(get_effective_actor)
        request_id = uuid4().hex
        await self.record_message_usage(
            project_id=project_id, task_id=None, message_id=request_id,
            run_id=None, model=model, occurred_at=datetime.now(timezone.utc),
            provider=provider,
            provider_id=provider.get("id") if provider else None,
            usage_json=json.dumps(usage) if usage else None,
            user_id=actor.actor_id if actor else None,
        )

    async def publish_project(self, project_id: str, *, published: bool) -> dict:
        if self.managed_config is None or self.control_client is None or not self.device_id:
            raise ConnectionError("Managed Gateway is unavailable")
        require_managed_capability("project.publish")
        project = project_manager.get_project_by_id(project_id)
        if project is None:
            raise KeyError("Project not found")
        return await self.control_client.publish_project(
            self.device_id, project.id, project.name,
            "publish" if published else "unpublish",
        )

    async def project_publication_status(self, project_id: str) -> dict:
        if self.managed_config is None or self.control_client is None or not self.device_id:
            raise ConnectionError("Managed Gateway is unavailable")
        project = project_manager.get_project_by_id(project_id)
        if project is None:
            raise KeyError("Project not found")
        result = await self.control_client.project_publication_status(
            self.device_id, project.id, project.name,
        )
        return {**result, "gateway_url": self.managed_config.gateway_origin}

    async def close(self) -> None:
        if self._restore_task:
            self._restore_task.cancel()
            await asyncio.gather(self._restore_task, return_exceptions=True)
            self._restore_task = None
        if self.control_client is not None:
            await self.control_client.stop()
            self.control_client = None
        self.policy_cache.clear()
        self.local_sessions.clear()
        self.device_id = None
        self.current_user_id = None
        self.current_actor = None
        await asyncio.to_thread(config_store.set_managed_gateway_id, None)
