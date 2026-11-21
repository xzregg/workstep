"""WorkStep internal tool registry.

Exposes daemon REST endpoints as structured tools that Agent helpers can load
on demand (CLI and engine-injected tools share ``WorkstepClient``). The client
talks HTTP to the local daemon, so tool behavior always matches the frontend's
API contract.
"""

import asyncio
import json
import os
import re
from urllib.parse import quote, urlencode
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

import httpx
from services.local_cli import local_cli_headers, local_origin

DEFAULT_DAEMON_URL = "http://127.0.0.1:8765"


@dataclass(frozen=True)
class WorkstepTool:
    """One WorkStep operation exposed to agents as a tool."""

    name: str
    description: str
    method: str
    path: str
    parameters: dict[str, dict] = field(default_factory=dict)
    required: tuple[str, ...] = ()
    read_only: bool = True
    side_effect: str = ""
    path_params: tuple[str, ...] = ()
    query_params: tuple[str, ...] = ()
    body_params: tuple[str, ...] = ()

    def example(self) -> str:
        """A JSON example of calling this tool."""
        sample = {key: "..." for key in self.required}
        if not self.read_only:
            sample["confirm"] = "yes"
        return json.dumps(sample, ensure_ascii=False)


# Compatibility dispatch only; not advertised to models.
_LEGACY_MEMORY_HISTORY = WorkstepTool(
        name="workstep_memory_history",
        description="Review authoritative terminal chat and workflow messages within since/before or a calendar period, independent of index lag. Pass snapshot and next_cursor until has_more=false; explicitly disclose coverage gaps. Separate plans from completed work and assistant claims from execution evidence.",
        method="POST", path="/api/memory/history",
        parameters={"cursor": {"type": "integer"}, "snapshot": {"type": "string"}, "limit": {"type": "integer"},
                    "since": {"type": "string"}, "before": {"type": "string"}, "period": {"type": "string"},
                    "timezone_name": {"type": "string"}},
        required=(),
        body_params=("project_id", "session_id", "filter_project_id", "filter_session_id", "cursor", "snapshot", "limit", "since", "before", "period", "timezone_name"),
    )


WORKSTEP_TOOLS: list[WorkstepTool] = [
    WorkstepTool(
        name="workstep_get_message",
        description="Read one original persisted chat message by WorkStep session_id and message_id, without memory search. Project-addressable session IDs locate the database directly; project_id is optional for legacy IDs.",
        method="GET", path="/api/chat-sessions/{session_id}/messages/{message_id}",
        parameters={key: {"type": "string"} for key in ("session_id", "message_id", "project_id")},
        required=("session_id", "message_id"), path_params=("session_id", "message_id"),
        query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_send_message",
        description="Queue a new turn in an existing ordinary project conversation without interrupting its current turn. Returns the acceptance status and message IDs.",
        method="POST", path="/api/chat-sessions/{session_id}/chat",
        parameters={
            **{key: {"type": "string"} for key in ("project_id", "session_id", "content")},
            "idempotency_key": {"type": "string", "description": "Reuse for a retry of the same instruction"},
        },
        required=("project_id", "session_id", "content"), path_params=("session_id",),
        query_params=("project_id",), body_params=("project_id", "content"),
        read_only=False, side_effect="Queue a real execution turn in the target conversation",
    ),
    WorkstepTool(
        name="workstep_archive_chat_session",
        description="Archive an idle ordinary project conversation using its WorkStep project and session IDs.",
        method="PATCH", path="/api/chat-sessions/{session_id}/archive",
        parameters={key: {"type": "string"} for key in ("project_id", "session_id")},
        required=("project_id", "session_id"), path_params=("session_id",),
        query_params=("project_id",), body_params=("project_id",),
        read_only=False, side_effect="Archive the conversation or clear it if it is an empty, non-forked chat",
    ),
    WorkstepTool(
        name="workstep_memory_pending",
        description="Step 1 of background assessment: fetch this execution's assigned unprocessed evidence and companion context. Only the active scheduler assessment can provide a batch. Repeated calls return the same batch. Follow read_ids/read_ranges before producing the final structured assessment. This does not mark evidence completed.",
        method="POST", path="/api/memory/pending",
        parameters={},
        required=(), body_params=("project_id", "session_id", "filter_project_id", "filter_session_id", ),
    ),
    WorkstepTool(
        name="workstep_remember_digital_person_rule",
        description="Save one standing agreement explicitly requested by the user in the host's main conversation. Reminders and time-bound actions use scheduling.",
        method="POST", path="/api/digital-person/standing-memory",
        parameters={"rule": {"type": "string", "description": "One enduring rule, on one line."}},
        required=("rule",), body_params=("rule",),
        read_only=False, side_effect="Append the rule to the host's standing memory",
    ),
    WorkstepTool(
        name="workstep_check_digital_person",
        description="Trigger one background digital-person reflection when the user explicitly asks; returns accepted without waiting for results. May update memory, relationships and send notifications under existing policies. Does not enable recurring reflection.",
        method="POST", path="/api/digital-person/check",
        parameters={"background": {"type": "boolean"}}, query_params=("background",),
        read_only=False, side_effect="Run companion reflection and apply its decisions",
    ),
    WorkstepTool(
        name="workstep_stop_digital_person_check",
        description="Stop the active digital-person assessment cycle when explicitly requested by the user. Keeps source conversations and saved knowledge.",
        method="POST", path="/api/digital-person/check/stop",
        read_only=False, side_effect="Cancel the active digital-person assessment cycle",
    ),
    WorkstepTool(
        name="workstep_memory_search",
        description="For ordinary recall and date summaries, search organized knowledge first with knowledge_only=true and limit=8. Derive text clues from user intent; exact entity filters combine with AND and also select knowledge. Dates constrain the knowledge event time. If coverage is insufficient, or exact messages or a complete timeline are requested, browse original records in small pages using snapshot/next_cursor. Use include_sources only when original wording is needed.",
        method="POST", path="/api/memory/search",
        parameters={"query": {"type": "string", "description": "Intent-derived text clues; omit for complete source review, optionally bounded by dates."},
                    "knowledge_only": {"type": "boolean", "description": "Return organized knowledge only, with optional date bounds. No fallback to original records."},
                    **{kind: {"type": "string", "description": "Exact typed entity name or alias; AND across dimensions. time is a stored tag, not a date range."}
                       for kind in ("person", "event", "object", "place", "time")},
                    "relation": {"type": "string", "description": "Literal relationship substring anchored to selected person/object."},
                    "include_sources": {"type": "boolean", "description": "Fetch bounded original bodies for returned evidence; default false."},
                    "source_chars": {"type": "integer", "description": "Per-source characters: default 2400, maximum 6000; total body budget 12000."},
                    "cursor": {"type": "integer"}, "snapshot": {"type": "string"}, "limit": {"type": "integer"},
                    "since": {"type": "string"}, "before": {"type": "string"},
                    "period": {"type": "string", "description": "last_month, this_month, yesterday, today"},
                    "timezone_name": {"type": "string", "description": "IANA timezone; default Asia/Shanghai"}},
        required=(),
        body_params=("project_id", "session_id", "filter_project_id", "filter_session_id", "query", "cursor", "snapshot", "limit", "since", "before", "period", "timezone_name", "include_sources", "source_chars", "person", "event", "object", "place", "time", "relation", "knowledge_only"),
    ),
    WorkstepTool(
        name="workstep_memory_read",
        description="Read a memory's original source text with offset/limit paging; events=true reads workflow execution events with event offset. Use an actual memory ID from search/pending, not an invented ID.",
        method="POST", path="/api/memory/read",
        parameters={"memory_id": {"type": "string"},
                    "offset": {"type": "integer"}, "limit": {"type": "integer"}, "events": {"type": "boolean"}},
        required=("memory_id",), body_params=("project_id", "session_id", "filter_project_id", "filter_session_id", "memory_id", "offset", "limit", "events"),
    ),
    WorkstepTool(
        name="workstep_list_digital_person_delegations",
        description="List recent delegations from the current digital-person conversation by project_id, or use delegation_id to read that delegation's latest status and execution result.",
        method="GET", path="/api/digital-person/delegations",
        parameters={"project_id":{"type":"string"},"origin_session_id":{"type":"string"},
                    "delegation_id":{"type":"string"}},
        required=("origin_session_id",), query_params=("project_id","origin_session_id","delegation_id"),
        read_only=True,
    ),
    WorkstepTool(
        name="workstep_delegate_digital_person",
        description="Delegate project work. Use target_session_id to send to an existing project chat and track it automatically, or continuation_of to continue a prior delegation. Omit both to create a conversation. Reuse request_id on retry.",
        method="POST", path="/api/digital-person/delegate",
        parameters={"project_id":{"type":"string"},"instruction":{"type":"string"},"origin_session_id":{"type":"string"},"request_id":{"type":"string"},
                    "title":{"type":"string","description":"Short, accurate task title, one line of up to 60 characters"},
                    "continuation_of":{"type":"string","description":"Prior delegation ID in the same source conversation and project"},
                    "target_session_id":{"type":"string","description":"Existing ordinary project chat to track as a delegation"}},
        required=("project_id","instruction","origin_session_id","request_id"),
        body_params=("project_id","title","instruction","origin_session_id","request_id","continuation_of","target_session_id"),
        read_only=False, side_effect="Create an execution conversation or submit another turn to an existing delegation",
    ),
    WorkstepTool(
        name="workstep_list_projects",
        description=(
            "List all registered WorkStep projects with id, name, path and "
            "workflow steps."
        ),
        method="GET",
        path="/api/project/list",
        read_only=True,
    ),
    WorkstepTool(
        name="workstep_get_project",
        description=(
            "Get one registered project by id; returns id, name, path and steps."
        ),
        method="GET",
        path="/api/project/list",
        parameters={"project_id": {"type": "string", "description": "project id"}},
        required=("project_id",),
        read_only=True,
    ),
    WorkstepTool(
        name="workstep_get_project_quick_buttons",
        description="List project chat quick buttons, including prompt, display, and Action settings.",
        method="GET", path="/api/chat-sessions/quick-buttons",
        parameters={"project_id": {"type": "string", "description": "project id"}},
        required=("project_id",), query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_set_project_quick_buttons",
        description="Save the complete project chat quick-button list.",
        method="PUT", path="/api/chat-sessions/quick-buttons",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "buttons": {"type": "array", "description": "complete button list"},
        },
        required=("project_id", "buttons"), read_only=False,
        side_effect="replace project chat quick buttons",
        body_params=("project_id", "buttons"),
    ),
    WorkstepTool(
        name="workstep_create_project_action",
        description="Create a project-wide Action shortcut and script after explicit authorization.",
        method="POST",
        path="/api/projects/{project_id}/actions",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "action_id": {"type": "string", "description": "stable Action slug"},
            "title": {"type": "string", "description": "button title"},
            "script_path": {"type": "string", "description": "script filename (.sh/.bash/.py)"},
            "script_content": {"type": "string", "description": "full script content"},
            "cwd_mode": {"type": "string", "description": "task, project or worktrees"},
            "require_confirmation": {"type": "boolean", "description": "confirm before execution"},
            "confirmation_input_prompt": {"type": "string", "description": "when non-empty, require confirmation text passed as WORKSTEP_ACTION_INPUT"},
        },
        required=("project_id", "action_id", "title", "script_path", "script_content"),
        read_only=False,
        side_effect="write a project Action script and register a global shortcut",
        path_params=("project_id",),
        body_params=("action_id", "title", "script_path", "script_content", "cwd_mode", "require_confirmation", "confirmation_input_prompt"),
    ),
    WorkstepTool(
        name="workstep_list_workflows",
        description=(
            "List workflows of a project, including ids, names, status and "
            "step counts."
        ),
        method="GET",
        path="/api/workflow/list",
        parameters={"project_id": {"type": "string", "description": "project id"}},
        required=("project_id",),
        read_only=True,
        query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_create_workflow",
        description="Create a new project workflow from a user-confirmed canvas definition. Does not change the project default workflow.",
        method="POST", path="/api/workflow/create",
        parameters={"project_id": {"type": "string"}, "name": {"type": "string"},
                    "steps": {"type": "object", "description": "canvas JSON with nodes and connections"}},
        required=("project_id", "name", "steps"), read_only=False,
        side_effect="create a project workflow",
        query_params=("project_id",), body_params=("name", "steps"),
    ),
    WorkstepTool(
        name="workstep_update_workflow",
        description="Update an existing workflow name or complete canvas after user authorization. Read the workflow first and preserve unrelated canvas settings.",
        method="PUT", path="/api/workflow/{workflow_id}",
        parameters={"project_id": {"type": "string"}, "workflow_id": {"type": "string"},
                    "name": {"type": "string"}, "steps": {"type": "object"}},
        required=("project_id", "workflow_id"), read_only=False,
        side_effect="update a project workflow",
        path_params=("workflow_id",), query_params=("project_id",), body_params=("name", "steps"),
    ),
    WorkstepTool(
        name="workstep_get_workflow",
        description="Get one workflow with its complete step definition, including workflow and stage quick buttons and inherited project button IDs.",
        method="GET",
        path="/api/workflow/{workflow_id}",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "workflow_id": {"type": "string", "description": "workflow id"},
        },
        required=("project_id", "workflow_id"),
        read_only=True,
        path_params=("workflow_id",),
        query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_create_workflow_action",
        description="Create a workflow Action shortcut, or explicitly overwrite an existing Action with the same ID after authorization.",
        method="POST",
        path="/api/workflow/{workflow_id}/actions",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "workflow_id": {"type": "string", "description": "workflow id"},
            "action_id": {"type": "string", "description": "stable Action slug"},
            "title": {"type": "string", "description": "button title"},
            "script_path": {"type": "string", "description": "script filename (.sh/.bash/.py)"},
            "script_content": {"type": "string", "description": "full script content"},
            "cwd_mode": {"type": "string", "description": "task, project or worktrees"},
            "require_confirmation": {"type": "boolean", "description": "confirm before execution"},
            "confirmation_input_prompt": {"type": "string", "description": "when non-empty, require confirmation text passed as WORKSTEP_ACTION_INPUT"},
            "overwrite": {"type": "boolean", "description": "replace only an existing workflow Action with the same ID"},
        },
        required=("project_id", "workflow_id", "action_id", "title", "script_path", "script_content"),
        read_only=False,
        side_effect="write a script and register a workflow shortcut",
        path_params=("workflow_id",),
        query_params=("project_id",),
        body_params=("action_id", "title", "script_path", "script_content", "cwd_mode", "require_confirmation", "confirmation_input_prompt", "overwrite"),
    ),
    WorkstepTool(
        name="workstep_list_tasks",
        description=(
            "List tasks of a project (optionally archived), including status, "
            "step progress and workflow info."
        ),
        method="GET",
        path="/api/task/list",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "archived": {"type": "boolean", "description": "show archived tasks only; default false"},
        },
        required=("project_id",),
        read_only=True,
        query_params=("project_id", "archived"),
    ),
    WorkstepTool(
        name="workstep_get_task",
        description="Get one task by id within a project.",
        method="GET",
        path="/api/task/{task_id}",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "task_id": {"type": "string", "description": "task id"},
        },
        required=("project_id", "task_id"),
        read_only=True,
        path_params=("task_id",),
        query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_get_task_history",
        description="Read paginated task messages, including coordinator conversation and proposals.",
        method="GET", path="/api/task/{task_id}/history",
        parameters={"project_id": {"type": "string"}, "task_id": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 300},
                    "offset": {"type": "integer", "minimum": 0}},
        required=("project_id", "task_id"), path_params=("task_id",),
        query_params=("project_id", "limit", "offset"),
    ),
    WorkstepTool(
        name="workstep_get_task_reviews",
        description="Read persisted task review history and decisions.",
        method="GET", path="/api/task/{task_id}/reviews",
        parameters={"project_id": {"type": "string"}, "task_id": {"type": "string"}},
        required=("project_id", "task_id"), path_params=("task_id",), query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_update_task",
        description='Update task title or description; omitted fields remain unchanged, description must be non-empty.',
        method='PATCH', path='/api/task/{task_id}',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}, 'title': {'type': 'string'}, 'description': {'type': 'string'}},
        required=('project_id', 'task_id'), read_only=False,
        side_effect='Update task title or description; omitted fields remain unchanged, description must be non-empty.',
        path_params=('task_id',), query_params=('project_id',),
        body_params=('title', 'description'),
    ),
    WorkstepTool(
        name="workstep_copy_task",
        description='Copy a task with a new title using the existing task copy behavior.',
        method='POST', path='/api/task/copy',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}, 'newTitle': {'type': 'string'}},
        required=('project_id', 'task_id', 'newTitle'), read_only=False,
        side_effect='Copy a task with a new title using the existing task copy behavior.',
        path_params=(), query_params=('project_id',),
        body_params=('task_id', 'newTitle'),
    ),
    WorkstepTool(
        name="workstep_delete_task",
        description='Delete a task. Set delete_workspace only with explicit authorization to remove or retain its worktrees; omitted preserves server safeguards.',
        method='DELETE', path='/api/task/delete',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}, 'delete_workspace': {'type': 'boolean'}},
        required=('project_id', 'task_id'), read_only=False,
        side_effect='Delete a task. Set delete_workspace only with explicit authorization to remove or retain its worktrees; omitted preserves server safeguards.',
        path_params=(), query_params=('project_id',),
        body_params=('task_id', 'delete_workspace'),
    ),
    WorkstepTool(
        name="workstep_stop_task",
        description='Request cancellation of the task workflow, not the coordinator conversation.',
        method='POST', path='/api/task/cancel',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}},
        required=('project_id', 'task_id'), read_only=False,
        side_effect='Request cancellation of the task workflow, not the coordinator conversation.',
        path_params=(), query_params=('project_id',),
        body_params=('task_id',),
    ),
    WorkstepTool(
        name="workstep_pause_task",
        description='Pause the task workflow.',
        method='POST', path='/api/task/pause',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}},
        required=('project_id', 'task_id'), read_only=False,
        side_effect='Pause the task workflow.',
        path_params=(), query_params=('project_id',),
        body_params=('task_id',),
    ),
    WorkstepTool(
        name="workstep_archive_task",
        description='Archive a non-running task without saving experience. Use archive experience tools when lessons are requested.',
        method='POST', path='/api/task/archive',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'},
                    'notify': {'type': 'boolean', 'description': 'Notify the group that originated the current coordinator turn'}},
        required=('project_id', 'task_id'), read_only=False,
        side_effect='Archive a non-running task without saving experience. Use archive experience tools when lessons are requested.',
        path_params=(), query_params=('project_id',),
        body_params=('task_id', 'notify'),
    ),
    WorkstepTool(
        name="workstep_unarchive_task",
        description='Restore an archived task.',
        method='POST', path='/api/task/unarchive',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}},
        required=('project_id', 'task_id'), read_only=False,
        side_effect='Restore an archived task.',
        path_params=(), query_params=('project_id',),
        body_params=('task_id',),
    ),
    WorkstepTool(
        name="workstep_retry_task_message",
        description='Retry a specific failed task message after inspecting history; does not reset an arbitrary step.',
        method='POST', path='/api/task/{task_id}/messages/{message_id}/retry',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}, 'message_id': {'type': 'string'}},
        required=('project_id', 'task_id', 'message_id'), read_only=False,
        side_effect='Retry a specific failed task message after inspecting history; does not reset an arbitrary step.',
        path_params=('task_id', 'message_id'), query_params=('project_id',),
        body_params=(),
    ),
    WorkstepTool(
        name="workstep_approve_task_review",
        description='Approve the current review round; may resume downstream execution.',
        method='POST', path='/api/task/{task_id}/steps/{step_key}/review/approve',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}, 'step_key': {'type': 'string'}, 'review_run_id': {'type': 'string'}, 'comment': {'type': 'string'}},
        required=('project_id', 'task_id', 'step_key', 'review_run_id'), read_only=False,
        side_effect='Approve the current review round; may resume downstream execution.',
        path_params=('task_id', 'step_key'), query_params=('project_id',),
        body_params=('review_run_id', 'comment'),
    ),
    WorkstepTool(
        name="workstep_reject_task_review",
        description='Reject the current review round with optional feedback.',
        method='POST', path='/api/task/{task_id}/steps/{step_key}/review/reject',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}, 'step_key': {'type': 'string'}, 'review_run_id': {'type': 'string'}, 'comment': {'type': 'string'}},
        required=('project_id', 'task_id', 'step_key', 'review_run_id'), read_only=False,
        side_effect='Reject the current review round with optional feedback.',
        path_params=('task_id', 'step_key'), query_params=('project_id',),
        body_params=('review_run_id', 'comment'),
    ),
    WorkstepTool(
        name="workstep_get_archive_experience",
        description='Read the saved archive experience draft; does not generate or archive.',
        method='GET', path='/api/task/{task_id}/archive-experience/draft',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}},
        required=('project_id', 'task_id'), read_only=True,
        side_effect='Read the saved archive experience draft; does not generate or archive.',
        path_params=('task_id',), query_params=('project_id',),
        body_params=(),
    ),
    WorkstepTool(
        name="workstep_prepare_archive_experience",
        description='Generate an experience draft in background. Supply a fresh UUID message_id and reuse it to poll this operation until a final result; running is not completed. Does not save Memory or archive.',
        method='POST', path='/api/task/{task_id}/archive-experience/prepare',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}, 'message_id': {'type': 'string'}, 'locale': {'type': 'string'}},
        required=('project_id', 'task_id', 'message_id'), read_only=False,
        side_effect='Generate an experience draft in background. Supply a fresh UUID message_id and reuse it to poll this operation until a final result; running is not completed. Does not save Memory or archive.',
        path_params=('task_id',), query_params=('project_id', 'message_id', 'background'),
        body_params=('locale',),
    ),
    WorkstepTool(
        name="workstep_stop_archive_experience",
        description='Stop the specified archive experience preparation.',
        method='POST', path='/api/task/{task_id}/archive-experience/stop',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}, 'message_id': {'type': 'string'}},
        required=('project_id', 'task_id', 'message_id'), read_only=False,
        side_effect='Stop the specified archive experience preparation.',
        path_params=('task_id',), query_params=('project_id', 'message_id'),
        body_params=(),
    ),
    WorkstepTool(
        name="workstep_confirm_archive_experience",
        description='Save supplied experience to project Memory and archive. experience must be supplied; empty is allowed only for a saved no-experience draft. Requires authorization for both saving and archiving.',
        method='POST', path='/api/task/{task_id}/archive-experience/confirm',
        parameters={'project_id': {'type': 'string'}, 'task_id': {'type': 'string'}, 'experience': {'type': 'string'}, 'locale': {'type': 'string'},
                    'notify': {'type': 'boolean', 'description': 'Notify the group that originated the current coordinator turn'}},
        required=('project_id', 'task_id', 'experience'), read_only=False,
        side_effect='Save supplied experience to project Memory and archive. experience must be supplied; empty is allowed only for a saved no-experience draft. Requires authorization for both saving and archiving.',
        path_params=('task_id',), query_params=('project_id',),
        body_params=('experience', 'locale', 'notify'),
    ),
    WorkstepTool(
        name="workstep_send_step_message",
        description="Queue a message for a running step or automatic review. Requires an engine supporting live step messages; queued does not mean delivered. Do not stop/restart as an automatic fallback.",
        method="POST",
        path="/api/task/{task_id}/step/{step_key}/message",
        parameters={
            "project_id": {"type": "string", "description": "current project id"},
            "task_id": {"type": "string", "description": "current task id"},
            "step_key": {"type": "string", "description": "existing workflow step key, not display title"},
            "content": {"type": "string", "description": "message with step-specific requirements and acceptance criteria"},
            "as_guidance": {"type": "boolean", "description": "also retain as guidance for later attempts; default false"},
        },
        required=("project_id", "task_id", "step_key", "content"),
        read_only=False,
        side_effect="send a message to the running step engine",
        path_params=("task_id", "step_key"),
        query_params=("project_id",),
        body_params=("content", "as_guidance"),
    ),
    WorkstepTool(
        name="workstep_stop_step",
        description="Request cancellation of one step and its pending interaction. Re-read the task and wait until the step is no longer running before the next dependent operation. Does not stop the coordinator conversation.",
        method="POST",
        path="/api/task/{task_id}/step/{step_key}/cancel",
        parameters={
            "project_id": {"type": "string", "description": "current project id"},
            "task_id": {"type": "string", "description": "current task id"},
            "step_key": {"type": "string", "description": "existing workflow step key, not display title"},
        },
        required=("project_id", "task_id", "step_key"),
        read_only=False,
        side_effect="cancel one step engine and its pending interaction",
        path_params=("task_id", "step_key"),
        query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_start_step",
        description="Start/resume a non-running step with a message, like @step. Stops the old task runner and restarts this step and its DAG downstream using existing input rules; not an isolated or force start. Preserve the session unless reset_session is explicitly requested.",
        method="POST",
        path="/api/task/{task_id}/step/{step_key}/resume",
        parameters={
            "project_id": {"type": "string", "description": "current project id"},
            "task_id": {"type": "string", "description": "current task id"},
            "step_key": {"type": "string", "description": "existing workflow step key, not display title"},
            "content": {"type": "string", "description": "startup message with requirements; required even when only continuing"},
            "reset_session": {"type": "boolean", "description": "start a fresh engine session only when explicitly requested; default false"},
        },
        required=("project_id", "task_id", "step_key", "content"),
        read_only=False,
        side_effect="stop the old task runner and start this step and its downstream",
        path_params=("task_id", "step_key"),
        query_params=("project_id",),
        body_params=("content", "reset_step", "allow_pending"),
    ),
    WorkstepTool(
        name="workstep_list_git_repositories",
        description="List Git repositories discovered in one project before choosing task worktrees.",
        method="GET",
        path="/api/git/projects/{project_id}/repositories",
        parameters={"project_id": {"type": "string", "description": "project id"}},
        required=("project_id",),
        path_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_get_task_workspace",
        description="List only the Git worktrees attached to one task.",
        method="GET",
        path="/api/git/projects/{project_id}/tasks/{task_id}/workspace",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "task_id": {"type": "string", "description": "task id"},
        },
        required=("project_id", "task_id"),
        path_params=("project_id", "task_id"),
    ),
    WorkstepTool(
        name="workstep_add_task_worktree",
        description="Create a task-specific Git worktree only for a repository needed by the task.",
        method="POST",
        path="/api/git/projects/{project_id}/tasks/{task_id}/worktrees",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "task_id": {"type": "string", "description": "task id"},
            "repository_id": {"type": "string", "description": "id from workstep_list_git_repositories"},
            "alias": {"type": "string", "description": "directory name within the task workspace"},
            "base_ref": {"type": "string", "description": "base branch or commit; defaults to HEAD"},
            "branch_name": {"type": "string", "description": "new branch name; defaults to workstep/<task_id>/<alias>"},
        },
        required=("project_id", "task_id", "repository_id", "alias"),
        read_only=False,
        side_effect="create a Git branch and worktree for this task",
        path_params=("project_id", "task_id"),
        body_params=("repository_id", "alias", "base_ref", "branch_name"),
    ),
    WorkstepTool(
        name="workstep_list_channel_bots", description="List configured channel robots without secrets.",
        method="GET", path="/api/channel-bots",
    ),
    WorkstepTool(
        name="workstep_list_channel_sessions", description="List active channel sessions and their exact recipients in one project.",
        method="GET", path="/api/channel-bots/sessions",
        parameters={"project_id": {"type": "string", "description": "project id"}},
        required=("project_id",), query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_bind_channel_group",
        description="Bind the current group channel session to a task in its project after the group user explicitly asks.",
        method="POST", path="/api/channel-bots/sessions/{session_id}/bind-task",
        parameters={
            "session_id": {"type": "string", "description": "current channel session id from system context"},
            "project_id": {"type": "string", "description": "project id of the current channel session"},
            "task_id": {"type": "string", "description": "existing target task id"},
        },
        required=("session_id", "project_id", "task_id"), read_only=False,
        side_effect="bind the current platform group to a task",
        path_params=("session_id",), body_params=("project_id", "task_id"),
    ),
    WorkstepTool(
        name="workstep_unbind_channel_group",
        description="Unbind an exact task discussion group. Notify that group only when explicitly requested.",
        method="DELETE", path="/api/task/{task_id}/discussion-groups/{bot_id}/{group_id}",
        parameters={key: {"type": "string"} for key in ("project_id", "task_id", "bot_id", "group_id")}
        | {"notify": {"type": "boolean", "description": "Send a final unbind notice; defaults to false"}},
        required=("project_id", "task_id", "bot_id", "group_id"), read_only=False,
        side_effect="remove a task discussion-group binding and optionally notify that group",
        path_params=("task_id", "bot_id", "group_id"), query_params=("project_id", "notify"),
    ),
    WorkstepTool(
        name="workstep_search_channel_contacts", description="Search a bot's in-memory directory by name, department or ID. Never refreshes the platform directory. Resolve duplicate names by asking the user to choose a contact_id.",
        method="GET", path="/api/channel-bots/{bot_id}/contacts",
        parameters={"bot_id":{"type":"string"}, "project_id":{"type":"string"},
                    "query":{"type":"string"}, "offset":{"type":"integer"}, "limit":{"type":"integer"}},
        required=("bot_id", "project_id"), read_only=True,
        path_params=("bot_id",), query_params=("project_id", "query", "offset", "limit"),
    ),
    WorkstepTool(
        name="workstep_send_channel_message", description="Send a notification via a channel session, or bot plus user/group, only when authorized. A unique exact user_name or a searched contact_id can replace user_id; never guess between duplicate names.",
        method="POST", path="/api/channel-bots/send",
        parameters={key: {"type": "string", "description": description} for key, description in {
            "project_id": "project id", "text": "message text", "session_id": "existing channel session id",
            "bot_id": "bot id for explicit recipient", "user_id": "platform user id", "group_id": "platform group id",
            "user_name": "exact directory name", "contact_id": "selected directory contact id",
        }.items()} | {"attachments": {"type": "array", "description": "image/file attachments with project-relative path and kind"}},
        required=("project_id",), read_only=False, side_effect="send an external channel message",
        body_params=("project_id", "text", "session_id", "bot_id", "user_id", "group_id", "user_name", "contact_id", "attachments"),
    ),
    WorkstepTool(
        name="workstep_upload_channel_attachment", description="Upload a user-authorized local attachment into a project for channel delivery.",
        method="POST", path="/api/fs/upload/file",
        parameters={key: {"type":"string"} for key in ("project_id", "filename", "data_url")},
        required=("project_id", "filename", "data_url"), read_only=False, side_effect="save attachment to project uploads",
        query_params=("project_id",), body_params=("filename", "data_url"),
    ),
    WorkstepTool(
        name="workstep_list_engines",
        description=(
            "List installed LLM engines and their capabilities (coordinator, "
            "resume, vision support)."
        ),
        method="GET",
        path="/api/engine/list",
        read_only=True,
    ),
    WorkstepTool(
        name="workstep_create_project",
        description=(
            "Create and register a new WorkStep project at an absolute path."
        ),
        method="POST",
        path="/api/project/init",
        parameters={
            "path": {"type": "string", "description": "absolute project directory path"},
            "name": {"type": "string", "description": "project name; defaults to the directory name"},
        },
        required=("path",),
        read_only=False,
        side_effect="initialize a project directory and register it in WorkStep",
        body_params=("path", "name"),
    ),
    WorkstepTool(
        name="workstep_create_task",
        description=(
            "Create a task in a project. cwd defaults to the project path when "
            "omitted."
        ),
        method="POST",
        path="/api/task/create",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "title": {"type": "string", "description": "task title"},
            "cwd": {"type": "string", "description": "working directory; defaults to the project path"},
            "description": {"type": "string", "description": "task description (optional)"},
            "workflow_id": {"type": "string", "description": "target workflow id (optional; defaults to the project default workflow)"},
            "start_step_key": {"type": "string", "description": "workflow step key to start from (optional)"},
            "auto_start": {"type": "boolean", "description": "false to create without starting; omit to inherit workflow defaults"},
        },
        required=("project_id", "title"),
        read_only=False,
        side_effect="create a task in the project",
        query_params=("project_id",),
        body_params=("title", "cwd", "description", "workflow_id", "start_step_key", "auto_start"),
    ),
    WorkstepTool(
        name="workstep_run_task",
        description="Start an existing task after explicit user confirmation. Reuse the created task if startup fails; do not create a replacement.",
        method="POST", path="/api/task/run",
        parameters={"project_id": {"type": "string"}, "task_id": {"type": "string"}, "prompt": {"type": "string"}},
        required=("project_id", "task_id"), read_only=False,
        side_effect="start execution of an existing task",
        query_params=("project_id",), body_params=("task_id", "prompt"),
    ),
    WorkstepTool(
        name="workstep_list_schedules",
        description="List project schedules with status and next run time.",
        method="GET", path="/api/schedule/list",
        parameters={"project_id": {"type": "string", "description": "project id"}, "target_type": {"type":"string", "enum":["project","task","session"]}, "task_id":{"type":"string"}, "session_id":{"type":"string"}},
        required=("project_id",), query_params=("project_id", "target_type", "task_id", "session_id"),
    ),
    WorkstepTool(
        name="workstep_get_schedule",
        description="Get one project schedule and its normalized rule.",
        method="GET", path="/api/schedule/{schedule_id}",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "schedule_id": {"type": "string", "description": "schedule id"},
        },
        required=("project_id", "schedule_id"), path_params=("schedule_id",),
        query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_schedule_notification_options", description="List scoped channel destinations and bound task default.",
        method="GET", path="/api/schedule/notification-options",
        parameters={"project_id":{"type":"string"},"task_id":{"type":"string"}}, required=("project_id",),
        query_params=("project_id","task_id"),
    ),
    WorkstepTool(
        name="workstep_retry_schedule_notification", description="Retry a failed channel notification without rerunning the occurrence.",
        method="POST", path="/api/schedule/{schedule_id}/runs/{run_id}/notification/retry",
        parameters={"project_id":{"type":"string"},"schedule_id":{"type":"string"},"run_id":{"type":"string"}},
        required=("project_id","schedule_id","run_id"), path_params=("schedule_id","run_id"), query_params=("project_id",),
        read_only=False, side_effect="resend the configured occurrence notification",
    ),
    WorkstepTool(
        name="workstep_create_schedule",
        description=(
            "Create a schedule. rule supports once/daily/weekly/monthly/interval/minutes/cron; "
            "project target uses workflow_id and task_template; task target requires target_task_id and instruction. "
            "session target requires target_session_id and instruction, sends in the existing conversation and automatically forwards channel replies. "
            "Use rule {kind: after, delay: 2h, timezone: Asia/Shanghai} for a one-time delay; do not use recurring minutes for this."
        ),
        method="POST", path="/api/schedule/create",
        parameters={
            "idempotency_key": {"type":"string", "description":"Stable originating user message/request ID; reuse on retry"},
            "target_type": {"type":"string", "enum":["project","task","session"]},
            "target_task_id": {"type":"string"},
            "target_session_id": {"type":"string", "description":"WorkStep conversation ID from current context, not engine thread or external group ID"},
            "instruction": {"type":"string", "description":"Free-form instruction for task coordinator"},
            "stop_condition": {"type":"string", "enum":["manual","task_terminal"]},
            "notification": {"type":"object", "description":"enabled boolean; target: session_id OR bot_id and group_id. Defaults on only for task with bound group."},
            "project_id": {"type": "string", "description": "project id"},
            "workflow_id": {"type": "string", "description": "workflow id"},
            "name": {"type": "string", "description": "schedule name"},
            "task_template": {"type": "object", "description": "task template; must include title"},
            "rule": {"type": "object", "description": "structured schedule rule"},
            "execution_mode": {"type": "string", "description": "workflow/immediate/manual"},
            "overlap_policy": {"type": "string", "description": "skip/parallel/queue"},
        },
        required=("project_id", "name", "rule"),
        read_only=False, side_effect="create and enable a project schedule",
        query_params=("project_id",),
        body_params=("idempotency_key", "target_type", "target_task_id", "target_session_id", "instruction", "stop_condition", "notification", "workflow_id", "name", "task_template", "rule", "execution_mode", "overlap_policy"),
    ),
    WorkstepTool(
        name="workstep_update_schedule",
        description="Update an existing project schedule and recalculate its next run.",
        method="PATCH", path="/api/schedule/{schedule_id}",
        parameters={
            "target_type": {"type":"string", "enum":["project","task","session"]},
            "target_task_id": {"type":"string"},
            "target_session_id": {"type":"string", "description":"WorkStep conversation ID from current context, not engine thread or external group ID"},
            "instruction": {"type":"string", "description":"Free-form instruction for task coordinator"},
            "stop_condition": {"type":"string", "enum":["manual","task_terminal"]},
            "notification": {"type":"object", "description":"enabled boolean; target: session_id OR bot_id and group_id. Defaults on only for task with bound group."},
            "project_id": {"type": "string", "description": "project id"},
            "schedule_id": {"type": "string", "description": "schedule id"},
            "name": {"type": "string", "description": "new name"},
            "workflow_id": {"type": "string", "description": "new workflow id"},
            "task_template": {"type": "object", "description": "complete task template"},
            "rule": {"type": "object", "description": "structured schedule rule"},
            "execution_mode": {"type": "string", "description": "workflow/immediate/manual"},
            "overlap_policy": {"type": "string", "description": "skip/parallel/queue"},
        },
        required=("project_id", "schedule_id"), read_only=False,
        side_effect="update and recalculate a project schedule",
        path_params=("schedule_id",), query_params=("project_id",),
        body_params=("target_type", "target_task_id", "target_session_id", "instruction", "stop_condition", "notification", "name", "workflow_id", "task_template", "rule", "execution_mode", "overlap_policy"),
    ),
    *[
        WorkstepTool(
            name=f"workstep_{action}_schedule",
            description=f"{action.title()} one project schedule.",
            method="POST" if action != "delete" else "DELETE",
            path=f"/api/schedule/{{schedule_id}}/{action}" if action != "delete" else "/api/schedule/{schedule_id}",
            parameters={
                "project_id": {"type": "string", "description": "project id"},
                "schedule_id": {"type": "string", "description": "schedule id"},
            },
            required=("project_id", "schedule_id"), read_only=False,
            side_effect={"pause": "pause the schedule", "resume": "resume the schedule", "delete": "delete the schedule and its run logs"}[action],
            path_params=("schedule_id",), query_params=("project_id",),
        )
        for action in ("pause", "resume", "delete")
    ],
    WorkstepTool(
        name="workstep_list_schedule_runs",
        description="List execution logs of one project schedule.",
        method="GET", path="/api/schedule/{schedule_id}/runs",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "schedule_id": {"type": "string", "description": "schedule id"},
            "limit": {"type": "integer", "description": "result count; default 50"},
            "offset": {"type": "integer", "description": "pagination offset"},
        },
        required=("project_id", "schedule_id"), path_params=("schedule_id",),
        query_params=("project_id", "limit", "offset"),
    ),
]

# Custom engine tools share the same host-scoped APIs as settings.
WORKSTEP_TOOLS.extend([
    WorkstepTool(
        name="workstep_custom_engine_inspect", description="Inspect a Python adapter/package in an isolated worker.",
        method="POST", path="/api/engine/custom/inspect", parameters={"path": {"type": "string"}},
        required=("path",), body_params=("path",), read_only=False, side_effect="load user adapter in a worker",
    ),
    WorkstepTool(
        name="workstep_custom_engine_configure", description="Save custom adapter configuration and provider binding.",
        method="POST", path="/api/engine/custom/configure",
        parameters={key: {"type": kind} for key, kind in (("path", "string"), ("values", "object"), ("clear", "object"), ("confirmed", "object"), ("provider_id", "string"), ("model", "string"))},
        required=("path",), body_params=("path", "values", "clear", "confirmed", "provider_id", "model"),
        read_only=False, side_effect="save custom engine configuration",
    ),
    WorkstepTool(
        name="workstep_custom_engine_operation", description="Start install or full validation; poll the returned operation ID.",
        method="POST", path="/api/engine/custom/operations",
        parameters={"path": {"type": "string"}, "action": {"type": "string", "enum": ["install", "validate"]}},
        required=("path", "action"), body_params=("path", "action"), read_only=False, side_effect="install dependencies or run real acceptance tests",
    ),
    WorkstepTool(
        name="workstep_custom_engine_operation_get", description="Read installation/validation status and measured results.",
        method="GET", path="/api/engine/custom/operations/{operation_id}",
        parameters={"operation_id": {"type": "string"}}, required=("operation_id",), path_params=("operation_id",),
    ),
    WorkstepTool(
        name="workstep_custom_engine_operation_stop", description="Stop a custom engine install or acceptance operation.",
        method="POST", path="/api/engine/custom/operations/{operation_id}/stop",
        parameters={"operation_id": {"type": "string"}}, required=("operation_id",), path_params=("operation_id",),
        read_only=False, side_effect="cancel worker and its child processes",
    ),
    WorkstepTool(
        name="workstep_custom_engine_register", description="Register only an unchanged package with signed successful acceptance; replace explicitly updates an existing custom engine.",
        method="POST", path="/api/engine/custom/register",
        parameters={"path": {"type": "string"}, "replace": {"type": "boolean"}}, required=("path",),
        body_params=("path", "replace"), read_only=False, side_effect="install adapter package",
    ),
    WorkstepTool(
        name="workstep_custom_engine_export", description="Export a portable source ZIP, excluding dependencies and credentials.",
        method="POST", path="/api/engine/custom/export",
        parameters={"engine_id": {"type": "string"}, "output": {"type": "string"}}, required=("engine_id", "output"),
        body_params=("engine_id", "output"), read_only=False, side_effect="write ZIP file on daemon host",
    ),
    WorkstepTool(
        name="workstep_custom_engine_disable", description="Disable or re-enable a faulty custom engine (separate from selector visibility).",
        method="POST", path="/api/engine/custom/disable",
        parameters={"engine_id": {"type": "string"}, "disabled": {"type": "boolean"}}, required=("engine_id",),
        body_params=("engine_id", "disabled"), read_only=False, side_effect="disable or enable custom execution",
    ),
    WorkstepTool(
        name="workstep_custom_engine_rollback", description="Restore previous adapter/dependencies; restart then validate again.",
        method="POST", path="/api/engine/custom/rollback", parameters={"engine_id": {"type": "string"}},
        required=("engine_id",), body_params=("engine_id",), read_only=False, side_effect="restore previous custom adapter",
    ),
])

WORKSTEP_TOOLS.extend([
    WorkstepTool(name='workstep_create_skill_draft', description='Start an ordinary skill-making conversation in the fixed Runtime project root; does not allocate a draft directory or install a skill.', method='POST', path='/api/skills/onboarding', read_only=False, side_effect='create an ordinary Runtime chat session'),
    WorkstepTool(name="workstep_skin_list", description="List default and installed skins.", method="GET", path="/api/skins"),
    WorkstepTool(name="workstep_skin_contract", description="Read the versioned skin parts, states, properties, layouts and actions contract.", method="GET", path="/api/skins/contract"),
    WorkstepTool(name="workstep_skin_validate", description="Validate a v1/v2 skin package without executing its scripts and create an immutable preview; visual acceptance is still required.", method="POST", path="/api/skins/validate", parameters={"path": {"type": "string"}}, required=("path",), body_params=("path",)),
    WorkstepTool(name="workstep_skin_register", description="Register a validated skin. Replacing the same ID requires explicit replace.", method="POST", path="/api/skins/register", parameters={"path": {"type": "string"}, "replace": {"type": "boolean"}}, required=("path",), body_params=("path", "replace"), read_only=False, side_effect="install or update a skin package"),
    WorkstepTool(name="workstep_skin_export", description="Export a portable skin ZIP to an absolute local path.", method="POST", path="/api/skins/export", parameters={"skin_id": {"type": "string"}, "output": {"type": "string"}}, required=("skin_id", "output"), body_params=("skin_id", "output"), read_only=False, side_effect="write a skin ZIP"),
    WorkstepTool(name="workstep_skin_delete", description="Remove a custom skin from the catalog; the default skin is immutable.", method="DELETE", path="/api/skins/{skin_id}", parameters={"skin_id": {"type": "string"}}, required=("skin_id",), path_params=("skin_id",), read_only=False, side_effect="remove a skin registration"),
    WorkstepTool(name="workstep_language_list", description="List installed language packs.", method="GET", path="/api/language-packs"),
    WorkstepTool(name="workstep_language_contract", description="Read the language catalog, required keys and placeholder contract.", method="GET", path="/api/language-packs/contract"),
    WorkstepTool(name="workstep_language_validate", description="Validate a declarative language pack package; reports missing translations and builtin fallback.", method="POST", path="/api/language-packs/validate", parameters={"path": {"type": "string"}}, required=("path",), body_params=("path",)),
    WorkstepTool(name="workstep_language_register", description="Register a validated language pack. Replacing the same ID requires explicit replace.", method="POST", path="/api/language-packs/register", parameters={"path": {"type": "string"}, "replace": {"type": "boolean"}}, required=("path",), body_params=("path", "replace"), read_only=False, side_effect="install or update a language pack package"),
    WorkstepTool(name="workstep_language_export", description="Export a portable language pack ZIP to an absolute local path.", method="POST", path="/api/language-packs/export", parameters={"pack_id": {"type": "string"}, "output": {"type": "string"}}, required=("pack_id", "output"), body_params=("pack_id", "output"), read_only=False, side_effect="write a language pack ZIP"),
    WorkstepTool(name="workstep_language_delete", description="Remove a custom language pack from the catalog; builtin languages are immutable.", method="DELETE", path="/api/language-packs/{pack_id}", parameters={"pack_id": {"type": "string"}}, required=("pack_id",), path_params=("pack_id",), read_only=False, side_effect="remove a language pack registration"),
])

# Memory operations are CLI transport definitions, not model-native tools.
_MEMORY_CLI_TOOLS = [tool for tool in WORKSTEP_TOOLS if tool.name.startswith("workstep_memory_")]
WORKSTEP_TOOLS = [tool for tool in WORKSTEP_TOOLS if not tool.name.startswith("workstep_memory_")]

TOOL_BY_NAME: dict[str, WorkstepTool] = {
    tool.name: tool for tool in WORKSTEP_TOOLS
}
TOOL_BY_NAME.update({tool.name: tool for tool in _MEMORY_CLI_TOOLS})
TOOL_BY_NAME[_LEGACY_MEMORY_HISTORY.name] = _LEGACY_MEMORY_HISTORY



def tool_documentation() -> str:
    """Markdown documentation agents can read to learn the available tools."""
    lines = [
        "# WorkStep internal tools",
        "",
        "You can manage the WorkStep system by calling `workstep_call` with an "
        "operation and JSON arguments. Operations:",
        "",
    ]
    for tool in WORKSTEP_TOOLS:
        lines.append(f"## {tool.name}")
        lines.append(f"- Purpose: {tool.description}")
        if tool.parameters:
            params = ", ".join(
                f"{key} ({value.get('description', key)})"
                for key, value in tool.parameters.items()
            )
            lines.append(f"- Parameters: {params}")
        if tool.required:
            lines.append(f"- Required: {', '.join(tool.required)}")
        if not tool.read_only:
            lines.append(f"- Side effect: {tool.side_effect or 'has side effects'}")
            lines.append(
                "- Mutating calls require confirm='yes' and explicit user intent."
            )
        lines.append("")
    lines.append(
        "Rules: read-only operations are safe to use for inspection. Mutating "
        "operations require confirm='yes' and explicit user intent. "
        "Never fabricate ids — look them up first with the list/get operations."
    )
    return "\n".join(lines)


def workstep_tools_instruction() -> str:
    """Prompt section teaching an agent the WorkStep tools and their rules."""
    return (
        tool_documentation()
        + "\n\n"
        "Rules: read-only operations (list/get) may be used directly. "
        "Create, update, pause, resume, and delete operations have side effects; "
        "use them only with explicit user authorization and confirm='yes'. "
        "Never invent ids; look them up with list/get first."
    )


class WorkstepClient:
    """HTTP client for calling WorkStep daemon endpoints as tools."""

    def __init__(
        self,
        base_url: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.base_url = (
            base_url
            or os.environ.get("WORKSTEP_DAEMON_URL")
            or DEFAULT_DAEMON_URL
        ).rstrip("/")
        self._transport = transport

    async def call(
        self,
        operation: str,
        arguments: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        tool = TOOL_BY_NAME.get(operation)
        if tool is None:
            return {"ok": False, "error": f"Unknown operation: {operation}"}
        args = dict(arguments or {})
        if operation == 'workstep_get_message' and not args.get('project_id'):
            from services.chat_identity import session_project_id
            embedded = session_project_id(str(args.get('session_id', '')))
            if embedded:
                args['project_id'] = embedded
        if operation.startswith('workstep_memory_'):
            from services.conversation_context import current_conversation
            context=current_conversation()
            if context.get('ok') is not False:
                args.update(project_id=context['project_id'],session_id=context['session_id'])
        missing = [
            key for key in tool.required
            if (not args.get(key) or str(args[key]).strip() == "")
            and not (tool.name == "workstep_confirm_archive_experience"
                     and key == "experience" and isinstance(args.get(key), str))
        ]
        if missing:
            return {
                "ok": False,
                "error": f"Missing required parameter: {', '.join(missing)}",
            }
        if not tool.read_only and args.get("confirm") != "yes":
            return {
                "ok": False,
                "error": (
                    f"{tool.name} has side effects ({tool.side_effect}). "
                    "Run it only when explicitly requested by the user and pass confirm='yes'."
                ),
            }

        if tool.name == "workstep_get_project":
            listing = await self.call("workstep_list_projects", {})
            if not listing.get("ok", True):
                return listing
            for proj in listing.get("projects", []):
                if proj.get("id") == args.get("project_id"):
                    return proj
            return {
                "ok": False,
                "error": f"Project does not exist: {args.get('project_id')}",
            }

        if tool.name == "workstep_create_task" and not args.get("cwd"):
            project = await self.call(
                "workstep_get_project", {"project_id": args["project_id"]}
            )
            if "path" not in project:
                return {
                    "ok": False,
                    "error": (
                        "无法解析项目路径："
                        f"{project.get('error', '项目不存在')}"
                    ),
                }
            args["cwd"] = project["path"]

        if tool.name == "workstep_start_step":
            args["allow_pending"] = True
            if "reset_session" in args:
                args["reset_step"] = args.pop("reset_session")

        if tool.name == "workstep_update_task":
            if not any(key in args for key in ("title", "description")):
                return {"ok": False, "error": "Please provide at least a title or description"}
            if "description" in args and (not isinstance(args["description"], str) or not args["description"].strip()):
                return {"ok": False, "error": "Task description cannot be empty"}
        title_key = "newTitle" if tool.name == "workstep_copy_task" else "title"
        if tool.name in {"workstep_update_task", "workstep_copy_task"} and title_key in args:
            if not isinstance(args[title_key], str) or not args[title_key].strip():
                return {"ok": False, "error": "Task title cannot be empty"}
        if tool.name == "workstep_confirm_archive_experience" and not isinstance(args.get("experience"), str):
            return {"ok": False, "error": "experience is required; an empty string can be passed for an experience-less draft"}
        if tool.name == "workstep_prepare_archive_experience":
            args["background"] = True
        if tool.name == "workstep_check_digital_person":
            args["background"] = True

        request_headers = {}
        if tool.name in {"workstep_send_message", "workstep_archive_chat_session"}:
            from services.remote_access import has_project_edit_scope

            # Native tools can run under a project actor before using local HTTP.
            if not has_project_edit_scope(args["project_id"]):
                return {"ok": False, "error": "Project scope denied"}
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", str(args["session_id"])):
                return {"ok": False, "error": "Invalid identifier: session_id"}
        if tool.name == "workstep_send_message":
            key = args.get("idempotency_key")
            if key is None:
                key = str(uuid4())
            if not isinstance(key, str) or not re.fullmatch(r"[!-~]+", key):
                return {"ok": False, "error": "Idempotency key must use printable ASCII without spaces"}
            request_headers["Idempotency-Key"] = key

        project_id = args.get("project_id")

        url = tool.path
        if tool.name == "workstep_delegate_digital_person" and "target_session_id" in args:
            from services.remote_access import get_current_actor

            actor = get_current_actor()
            if actor is not None and actor.project_id is not None:
                return {"ok": False, "error": "Project scope denied"}
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", str(args["target_session_id"])):
                return {"ok": False, "error": "Invalid identifier: target_session_id"}
            if args.get("continuation_of"):
                return {"ok": False, "error": "Choose a target session or a prior delegation"}
            url += "/existing"
        for param in tool.path_params:
            value = str(args.pop(param))
            if tool.name == "workstep_unbind_channel_group":
                if value in (".", "..") or "/" in value or "\\" in value:
                    return {"ok": False, "error": f"Invalid identifier: {param}"}
                value = quote(value, safe="")
            url = url.replace("{" + param + "}", value)
        query = {
            key: args[key]
            for key in tool.query_params
            if key in args and args[key] not in (None, "")
        }
        body = {
            key: args.pop(key)
            for key in tool.body_params
            if key in args and args[key] not in (None, "")
        }
        # An empty experience confirms a saved no-experience draft.
        if tool.name == "workstep_confirm_archive_experience" and arguments.get("experience") == "":
            body["experience"] = ""
        if tool.name == "workstep_run_task":
            body.setdefault("prompt", "")
        if tool.name == "workstep_archive_chat_session":
            body.update(archived=True, ordinary_only=True)
        headers = await asyncio.to_thread(local_cli_headers, self.base_url)
        from services.coordinator_source import (
            COORDINATOR_TURN_ENV, COORDINATOR_TURN_HEADER, coordinator_source_env,
        )
        source_turn = coordinator_source_env().get(COORDINATOR_TURN_ENV) or os.environ.get(COORDINATOR_TURN_ENV)
        if source_turn and tool.name in {"workstep_start_step", "workstep_send_step_message"}:
            headers[COORDINATOR_TURN_HEADER] = source_turn
        # Never forward a desktop credential to --url on another machine.
        origin = local_origin(self.base_url)
        daemon_origin = local_origin(os.environ.get('WORKSTEP_DAEMON_URL') or DEFAULT_DAEMON_URL)
        if (source_turn and origin and origin == daemon_origin and body.get('notify') is True
                and tool.name in {'workstep_archive_task', 'workstep_confirm_archive_experience'}):
            headers[COORDINATOR_TURN_HEADER] = source_turn
        if origin and origin == daemon_origin and os.environ.get('WORKSTEP_DESKTOP_TOKEN'):
            headers['X-WorkStep-Desktop-Token'] = os.environ['WORKSTEP_DESKTOP_TOKEN']
        async with httpx.AsyncClient(
            base_url=self.base_url,
            transport=self._transport,
            timeout=130.0 if tool.name == "workstep_add_task_worktree" else 30.0,
            headers=headers,
        ) as client:
            try:
                response = await client.request(
                    tool.method,
                    url,
                    params=query,
                    json=body or None,
                    headers=request_headers,
                )
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                detail = ""
                try:
                    detail = str(exc.response.json().get("detail", ""))
                except Exception:
                    detail = exc.response.text[:300]
                if (origin is not None and not headers and exc.response.status_code == 401
                        and detail == "desktop authentication required"):
                    detail = "本机 CLI 凭据缺失或不可用，请重启目标 daemon 后重试；无需在浏览器登录。"
                return {
                    "ok": False,
                    "error": detail or f"HTTP {exc.response.status_code}",
                }
            except httpx.RequestError as exc:
                return {
                    "ok": False,
                    "error": f"Unable to connect to daemon ({self.base_url}): {exc}",
                }
        result = response.json()
        if (tool.name == "workstep_create_task"
                and isinstance(result, dict) and result.get("ok") is not False and result.get("id")):
            result["task_detail_url"] = "workstep-task://open?" + urlencode({
                "project_id": project_id, "task_id": result["id"],
            })
        return result
