"""Project-local conversation groups. All callers run in the project DB executor."""
import json
import logging
from uuid import uuid4

from models.base import db_proxy
from models.chat_session import ChatMessage, ChatSession, ProjectSetting
from models.fields import utc_now

KEY = "chat_session_groups"


def list_groups():
    # The database is the project boundary; registry IDs may change on reimport.
    row = ProjectSetting.get_or_none(ProjectSetting.key == KEY)
    groups = json.loads(row.value_json) if row else []
    active = {row.id for row in ChatSession.select(ChatSession.id).where(ChatSession.archived == False)}
    for group in groups:
        group["session_ids"] = [sid for sid in group["session_ids"] if sid in active]
    return groups


def _save(project_id, groups):
    row = ProjectSetting.get_or_none(ProjectSetting.key == KEY)
    payload = json.dumps(groups, ensure_ascii=False)
    if row:
        row.value_json = payload
        row.updated_at = utc_now()
        row.save()
    else:
        ProjectSetting.create(id=str(uuid4()), project_id=project_id, key=KEY,
                              value_json=payload, updated_at=utc_now())


def mutate_group(project_id, req, module):
    groups = list_groups()
    removed, skipped = [], []
    group = next((item for item in groups if item["id"] == req.group_id), None)
    if req.action == "create":
        name = req.name.strip()
        if not name or len(name) > 80:
            raise ValueError("Group name must contain 1–80 characters")
        groups.append({"id": str(uuid4()), "name": name, "source": req.source, "session_ids": []})
    elif req.action == "reorder":
        target = next((item for item in groups if item["id"] == req.target_group_id), None)
        if not group or not target:
            raise ValueError("Group not found")
        if group.get("source", "chat") != target.get("source", "chat"):
            raise ValueError("Group types do not match")
        if group != target:
            groups.remove(group)
            index = groups.index(target) + (0 if req.before else 1)
            groups.insert(index, group)
    elif req.action == "move":
        if req.group_id and not group:
            raise ValueError("Group not found")
        row = ChatSession.get_or_none(ChatSession.id == req.session_id, ChatSession.archived == False)
        if row is None:
            raise ValueError("Chat session not found")
        # Use the same source classification as the sidebar.
        summary = module._session_summary(row, project_id)
        source = "channel" if summary.get("source") == "channel" else "chat"
        if group and group.get("source", "chat") != source:
            raise ValueError("Conversation type does not match group")
        for item in groups:
            item["session_ids"] = [sid for sid in item["session_ids"] if sid != row.id]
        if group:
            group["session_ids"].append(row.id)
    elif req.action == "dissolve" or (req.action == "delete" and not req.delete_sessions):
        if not group:
            raise ValueError("Group not found")
        groups.remove(group)
    else:
        if not group:
            raise ValueError("Group not found")
        for sid in group["session_ids"]:
            running = any(state.get("session_id") == sid and state.get("status") in {"queued", "running", "stopping"}
                          for state in module._turn_states.values())
            running = running or ChatMessage.select().where(ChatMessage.session == sid, ChatMessage.status == "running").exists()
            if running:
                skipped.append(sid)
                continue
            try:
                if req.action == "archive":
                    module.set_archived(project_id, sid, True)
                else:
                    module.delete_session(project_id, sid)
                removed.append(sid)
            except Exception:
                logging.getLogger(__name__).exception("Conversation group member operation failed")
                skipped.append(sid)
        group["session_ids"] = skipped
        if not skipped:
            groups.remove(group)
    with db_proxy.atomic():
        _save(project_id, groups)
    return {"groups": groups, "removed": removed, "skipped": skipped}


def create_group_session(project_id, group_id, create):
    """Create and assign together; no orphan conversation on invalid/stale groups."""
    if not group_id:
        return create()
    with db_proxy.atomic():
        groups = list_groups()
        group = next((item for item in groups if item["id"] == group_id), None)
        if not group or group.get("source", "chat") != "chat":
            raise ValueError("Ordinary conversation group not found")
        session = create()
        group["session_ids"].append(session["id"])
        _save(project_id, groups)
        return session
