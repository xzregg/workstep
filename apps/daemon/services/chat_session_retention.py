"""Business identity for the data center's current foreground conversation."""
from engines.core.session_retention import release_session_retention


def main_session_retention_key(project_id: str, session_id: str) -> str:
    return f'digital_person:{project_id}:{session_id}'


async def release_main_session_retention(project_id: str, session_id: str):
    await release_session_retention(main_session_retention_key(project_id, session_id))
