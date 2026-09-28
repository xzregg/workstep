"""Create a consistent SQLite backup while Gateway is running."""

import argparse
import asyncio
from pathlib import Path

from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    await GatewayDatabase(GatewaySettings()).backup_sqlite(args.destination)


if __name__ == "__main__":
    asyncio.run(main())
