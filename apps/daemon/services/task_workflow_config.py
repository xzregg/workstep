"""Task workflow persistence. All functions run on a project DB executor."""

from copy import deepcopy
import json

from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from models.fields import utc_now
from services.task_workflow import (
    WorkflowConflict, build_overrides, canonical_workflow, merge_workflow, workflow_revision,
)


def source_workflow(project, task: Task) -> dict:
    if task.workflow_id:
        selected = project.workflow_by_id(task.workflow_id)
        if selected is None:
            raise WorkflowConflict(f"来源流程不存在: {task.workflow_id}")
        return deepcopy(selected["steps"])
    return deepcopy(project.steps)


def task_overrides(task: Task) -> dict | None:
    try:
        value = json.loads(task.workflow_overrides_json) if task.workflow_overrides_json else None
    except (ValueError, TypeError) as exc:
        raise WorkflowConflict("任务流程覆盖格式损坏") from exc
    if value is not None and not isinstance(value, dict):
        raise WorkflowConflict("任务流程覆盖格式无效")
    return value


def set_node_override(task: Task, key: str, fields: dict) -> None:
    """Compatibility writers use the same overlay, never a second authority."""
    from services.task_workflow import _patch

    delta = task_overrides(task) or {"version": 1, "nodes": {}}
    for node in delta.get("added_nodes", []):
        if node["type"] == key:
            updated = _patch(node, fields)
            if "config" in fields:
                updated["config"] = deepcopy(fields["config"])
            node.update(updated)
            task.workflow_overrides_json = json.dumps(delta, ensure_ascii=False)
            return
    patch = _patch(delta.get("nodes", {}).get(key, {}), fields)
    if "config" in fields:
        patch["config"] = deepcopy(fields["config"])
    delta.setdefault("nodes", {})[key] = patch
    task.workflow_overrides_json = json.dumps(delta, ensure_ascii=False)


def _store_delta(task, delta):
    used = set(delta.get("nodes", {}))
    for edge in [*delta.get("added_connections", []), *delta.get("removed_connections", [])]:
        used.update((edge["from"], edge["to"]))
    delta["guards"] = {key: guard for key, guard in delta.get("guards", {}).items() if key in used}
    meaningful = "bookmarks" in delta or any(delta.get(field) for field in (
        "nodes", "added_nodes", "added_connections", "removed_connections",
    ))
    task.workflow_overrides_json = json.dumps(delta, ensure_ascii=False) if meaningful else None


def set_execution_override(project, task, key, target):
    """The quick editor submits a full selection; persist only changed fields."""
    from services.config import resolve_execution_engine
    from services.task_workflow import _diff

    source = canonical_workflow(source_workflow(project, task))
    node = next((node for node in source["nodes"] if node["type"] == key), None)
    if node is None:
        set_node_override(task, key, target)
        return
    delta = task_overrides(task) or {"version": 1, "nodes": {}}
    patch = delta.setdefault("nodes", {}).setdefault(key, {})
    for field in ("engine", "model", "config"):
        patch.pop(field, None)
    changed_engine = resolve_execution_engine(node.get("engine")) != target["engine"]
    if changed_engine:
        patch["engine"] = target["engine"]
    if changed_engine or node.get("model", "") != target["model"]:
        patch["model"] = target["model"]
    config = _diff({} if changed_engine else node.get("config", {}), target["config"])
    if config:
        patch["config"] = config
    if not patch:
        delta["nodes"].pop(key, None)
    _store_delta(task, delta)


def set_review_override(task, key, review):
    """Preserve partial legacy callers, but do not pin unchanged review fields."""
    from models import Workflow
    from services.task_workflow import _diff

    workflow = Workflow.get_or_none(Workflow.id == task.workflow_id) if task.workflow_id else None
    if workflow is None:
        set_node_override(task, key, {"review": review})
        return
    source = canonical_workflow(json.loads(workflow.steps_json))
    node = next((node for node in source["nodes"] if node["type"] == key), None)
    if node is None:
        set_node_override(task, key, {"review": review})
        return
    review = deepcopy(review)
    if "engine" in review and review["engine"] != node["review"].get("engine"):
        review.setdefault("model", "")
        review.setdefault("config", {})
    if "auto" in review and "mode" not in review:
        review["mode"] = "auto" if review["auto"] else "manual"
    delta = task_overrides(task) or {"version": 1, "nodes": {}}
    patch = delta.setdefault("nodes", {}).setdefault(key, {})
    fields = patch.setdefault("review", {})
    changed_engine = review.get("engine", fields.get("engine", node["review"].get("engine"))) != node["review"].get("engine")
    for field, value in review.items():
        fields.pop(field, None)
        base = node["review"].get(field)
        if field == "config" and changed_engine:
            base = {}
        if isinstance(base, dict) and isinstance(value, dict):
            difference = _diff(base, value)
            if difference:
                fields[field] = difference
        elif base != value:
            fields[field] = value
    if not fields:
        patch.pop("review", None)
    if not patch:
        delta["nodes"].pop(key, None)
    _store_delta(task, delta)


def replace_review_overrides(task, reviews):
    delta = task_overrides(task)
    if delta:
        for key, patch in list(delta.get("nodes", {}).items()):
            if key not in reviews:
                patch.pop("review", None)
                if not patch:
                    delta["nodes"].pop(key)
        _store_delta(task, delta)
    for key, review in reviews.items():
        if not isinstance(review, dict):
            raise ValueError("审核配置必须为对象")
        set_review_override(task, key, review)


def resolve_task_workflow(project, task: Task) -> dict:
    """Legacy overrides are read-only fallbacks until the next configuration save."""
    source = source_workflow(project, task)
    items = source.get("nodes") if "nodes" in source else source.get("steps", [])
    by_key = {str(item.get("type") or item.get("key") or item.get("id")): item for item in items}
    for row in TaskStep.select().where(TaskStep.task == task):
        if row.execution_config_json and row.step_key in by_key:
            try:
                legacy = json.loads(row.execution_config_json)
                if isinstance(legacy, dict):
                    by_key[row.step_key].update(legacy)
            except (ValueError, TypeError):
                continue
    try:
        reviews = json.loads(task.review_overrides_json or "{}")
        reviews = reviews if isinstance(reviews, dict) else {}
    except (ValueError, TypeError):
        reviews = {}
    for key, review in reviews.items():
        if key in by_key and isinstance(review, dict):
            by_key[key]["review"] = {**(by_key[key].get("review") or {}), **review}
    return merge_workflow(source, task_overrides(task))


ACTIVE = {"running", "retrying", "rework", "reviewing", "rework_waiting"}


def require_editable(task: Task, active_runner: bool = False) -> None:
    if (active_runner or task.status in {"running", "queued"}
            or TaskStep.select().where((TaskStep.task == task) & TaskStep.status.in_(ACTIVE)).exists()
            or ReviewRun.select().where((ReviewRun.task == task) & ReviewRun.status.in_(["pending", "running"])).exists()):
        raise RuntimeError("请先停止任务执行和审核，再编辑任务流程")


def get_task_workflow(project, task_id: str, *, active_runner: bool = False) -> dict:
    task = Task.get_or_none(Task.id == task_id)
    if task is None:
        raise LookupError("Task not found")
    source = source_workflow(project, task)
    legacy = {row.step_key: row.execution_config_json for row in TaskStep.select().where(TaskStep.task == task)
              if row.execution_config_json}
    revision = workflow_revision({"source": source, "overrides": task_overrides(task),
                                  "reviews": task.review_overrides_json, "execution": legacy})
    conflict = None
    try:
        effective = canonical_workflow(resolve_task_workflow(project, task))
    except WorkflowConflict as exc:
        # A source-only repair view plus reset remains available; never executable.
        effective = canonical_workflow(source)
        conflict = str(exc)
    try:
        require_editable(task, active_runner)
        editable = True
    except RuntimeError:
        editable = False
    return {"workflow": effective, "source": canonical_workflow(source), "revision": revision,
            "has_overrides": bool(task.workflow_overrides_json or task.review_overrides_json or legacy),
            "editable": editable, "conflict": conflict,
            "overrides": task_overrides(task)}


def save_task_workflow(project, task_id: str, edited: dict | None, revision: str,
                       *, active_runner: bool = False, context_mode: str = "smart") -> dict:
    from services.step_execution_config import prepare_execution_handoff, validate_execution_config

    task = Task.get_or_none(Task.id == task_id)
    if task is None:
        raise LookupError("Task not found")
    require_editable(task, active_runner)
    current = get_task_workflow(project, task_id)
    if revision != current["revision"]:
        raise RuntimeError("流程配置已变化，请重新加载后保存")
    source = source_workflow(project, task)
    delta = build_overrides(source, edited) if edited is not None else None
    effective = canonical_workflow(merge_workflow(source, delta))
    old_added = {node["type"] for node in (task_overrides(task) or {}).get("added_nodes", [])}
    new_keys = {node["type"] for node in effective["nodes"]}
    if edited is not None:
        for key in old_added - new_keys:
            if (Message.select().where((Message.task == task) & (Message.step_key == key)).exists()
                    or StepRun.select().join(WorkflowRun).where(
                        (WorkflowRun.task == task) & (StepRun.step_key == key)).exists()):
                raise WorkflowConflict(f"已有执行历史，不能删除任务新增阶段: {key}")
    before = {node["type"]: node for node in current["workflow"]["nodes"]}
    with Task._meta.database.atomic():
        for node in effective["nodes"]:
            key = node["type"]
            previous = before.get(key, {})
            execution_fields = ("engine", "model", "config")
            if any(previous.get(field) != node.get(field) for field in execution_fields):
                validate_execution_config(node.get("engine"), node.get("config") or {})
            row, _ = TaskStep.get_or_create(task=task, step_key=key, defaults={"status": "pending"})
            if any(previous.get(field) != node.get(field) for field in ("engine", "config")):
                prepare_execution_handoff(project, task, row, previous, node, context_mode)
            row.execution_config_json = None
            row.save(only=[TaskStep.execution_config_json, TaskStep.pending_handoff_json])
        task.workflow_overrides_json = json.dumps(delta, ensure_ascii=False) if delta else None
        TaskStep.update(execution_config_json=None).where(TaskStep.task == task).execute()
        task.review_overrides_json = None
        task.state_version += 1
        task.updated_at = utc_now()
        task.save()
    return get_task_workflow(project, task_id)
