import asyncio
import os
from pathlib import Path

from .managed_config import InvalidManagedGatewayConfig, load_managed_config


class GatewayClientService:
    """Lifecycle placeholder for a future, explicitly configured managed client."""

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

    async def close(self) -> None:
        pass
