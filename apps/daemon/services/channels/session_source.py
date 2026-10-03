"""Project database projection of channel conversation identity.

Call inside the project database executor, like the enclosing session summary.
"""

from models.chat_session import ChatMessage
from services.config import config_store


def channel_session_source(session_id: str, title: str = "") -> dict:
    message = ChatMessage.select(ChatMessage.author_id, ChatMessage.author_device_id, ChatMessage.author_name).where(
        (ChatMessage.session == session_id)
        & (ChatMessage.role == "user")
        & ChatMessage.author_id.startswith("channel:")
        & ChatMessage.author_device_id.startswith("channel:")
    ).order_by(ChatMessage.created_at).first()
    if message is None:
        return {"source": "chat"}
    platform = message.author_id.split(":", 2)[1]
    bot_id = message.author_device_id.removeprefix("channel:")
    config = config_store.get("channel_bots", {})
    bots = config.get("bots", [])
    identity = config.get("session_sources", {}).get(session_id, {})
    if not identity:
        # Existing mappings can identify older conversations without guessing from titles.
        key = next((key for key, value in config.get("sessions", {}).items()
                    if value == session_id and key.startswith(f"{bot_id}:")), "")
        if key:
            _, conversation_type, conversation_id = key.split(":", 2)
            identity = {"conversation_type": conversation_type, "conversation_id": conversation_id}
    conversation_type = identity.get("conversation_type")
    peer_name = identity.get("peer_name") or identity.get("conversation_id")
    if conversation_type == "single" and not identity.get("peer_name"):
        peer_name = (message.author_name or "").split(" · ", 1)[-1] or peer_name
    if conversation_type == "group":
        peer_name = identity.get("group_name") or title or peer_name
    bot = next((item for item in bots if item.get("id") == bot_id), {})
    return {
        "source": "channel",
        "channel_platform": platform,
        "channel_name": bot.get("name") or None,
        "channel_conversation_type": conversation_type,
        "channel_peer_name": peer_name,
        "channel_conversation_id": identity.get("conversation_id"),
        "channel_group_name": (identity.get("group_name") or title or None) if conversation_type == "group" else None,
        "channel_sender_id": identity.get("sender_id"),
        "channel_sender_name": identity.get("sender_name"),
        "channel_initiator_id": identity.get("initiator_id") or message.author_id.split(":", 2)[-1],
        "channel_initiator_name": identity.get("initiator_name") or (message.author_name or "").split(" · ", 1)[-1],
    }
