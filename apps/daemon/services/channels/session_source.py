"""Project database projection of channel conversation identity.

Call inside the project database executor, like the enclosing session summary.
"""

from models.chat_session import ChatMessage
from services.config import config_store


def channel_session_source(session_id: str) -> dict:
    message = ChatMessage.select(ChatMessage.author_id, ChatMessage.author_device_id).where(
        (ChatMessage.session == session_id)
        & (ChatMessage.role == "user")
        & ChatMessage.author_id.startswith("channel:")
        & ChatMessage.author_device_id.startswith("channel:")
    ).order_by(ChatMessage.created_at).first()
    if message is None:
        return {"source": "chat"}
    platform = message.author_id.split(":", 2)[1]
    bot_id = message.author_device_id.removeprefix("channel:")
    bots = config_store.get("channel_bots", {}).get("bots", [])
    bot = next((item for item in bots if item.get("id") == bot_id), {})
    return {
        "source": "channel",
        "channel_platform": platform,
        "channel_name": bot.get("name") or None,
    }
