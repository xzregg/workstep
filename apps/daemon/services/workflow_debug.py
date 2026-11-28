"""Prepare a debug task as ordinary workflow data before starting the runtime."""

import json
import shutil
from collections import defaultdict
from pathlib import Path

from services.business_ids import new_id
from models import ReviewRun, Task, Workflow
from models.fields import utc_now
from services.artifact_rounds import (
    iter_artifact_rounds, next_artifact_round, select_upstream_round, step_round_dir,
    update_round_manifest_status, write_round_manifest,
)
from services.artifact_routing import source_for_connection
from services.global_artifacts import GLOBAL_DIRECTORY, prepare_global_artifacts
from services.pipeline import DAGScheduler, Step
from services.project_workflows import ProjectWorkflowService
from services.prompt import _artifact_extension, _output_path
from services.task_owned_storage import delete_task_artifacts, task_artifact_root
from services.task_state import task_has_active_execution
from services.workflow_definition import WorkflowDefinition


def debug_workflow(source_id):
    source = Workflow.get_or_none(
        Workflow.id == source_id, Workflow.deleted == 0, Workflow.debug_source_id.is_null(),
    )
    if source is None:
        raise LookupError("Source workflow not found")
    return source, Workflow.get_or_none(Workflow.debug_source_id == source.id)


def debug_records(source_id):
    """Materialize history inside the caller's project database executor."""
    _, debug = debug_workflow(source_id)
    if debug is None:
        return {"workflow_id": None, "workflow": None, "tasks": []}
    rows = Task.select().where(Task.workflow_id == debug.id).order_by(Task.created_at.desc())
    return {"workflow_id": debug.id, "workflow": json.loads(debug.steps_json),
            "tasks": [{"id": row.id, "title": row.title, "status": row.status,
                       "created_at": row.created_at} for row in rows]}


def debug_task_ids(source_id, task_id=None):
    _, debug = debug_workflow(source_id)
    if debug is None:
        return []
    query = Task.select(Task.id).where(Task.workflow_id == debug.id)
    if task_id is not None:
        query = query.where(Task.id == task_id)
    return [row.id for row in query]


def debug_task_active(task_id):
    task = Task.get_or_none(Task.id == task_id)
    return task is not None and task_has_active_execution(task)


def require_idle(debug):
    if debug is None:
        return
    tasks = list(Task.select().where(Task.workflow_id == debug.id))
    if any(task_has_active_execution(task) for task in tasks) or ReviewRun.select().where(
        ReviewRun.task.in_([task.id for task in tasks]),
        ReviewRun.status.in_(["pending", "running"]),
    ).exists():
        raise RuntimeError("Stop all debug tasks and resolve pending reviews before saving this workflow")


def compile_debug(workflow):
    compiled = WorkflowDefinition.load(workflow).compile()
    scheduler = DAGScheduler([Step.from_dict(value) for value in compiled.steps])
    if not scheduler.steps:
        raise ValueError("Add a step before debugging")
    if any(step.kind == "task_dispatch" for step in scheduler.steps.values()):
        raise ValueError("Debug workflows cannot dispatch tasks")
    return scheduler


def upstream_outputs(scheduler, step_key):
    step = scheduler.steps.get(step_key)
    if step is None:
        raise ValueError("Starting step not found")
    required = {}
    for edge in step.incoming_connections:
        if edge["kind"] == "dashed":
            continue
        producer = scheduler.steps[edge["from"]]
        port = edge["fromPort"]
        if port < len(producer.outputs):
            required[(producer.key, port)] = producer.outputs[port]
    return required


def write_samples(project, workflow_id, task_id, scheduler, required, samples):
    grouped = defaultdict(list)
    for source_port, content in samples.items():
        grouped[source_port[0]].append((source_port[1], content))
    artifacts = project.workstep_dir / "artifacts"
    rounds = {}
    created = []
    shared_samples = []
    try:
        prepare_global_artifacts(
            artifacts, workflow_id, task_id,
            [scheduler.steps[key] for key in grouped if any(required[key, port].get("global") for port, _ in grouped[key])],
        )
        for step_key, entries in grouped.items():
            outputs = scheduler.steps[step_key].outputs
            task_root = task_artifact_root(project.workstep_dir, workflow_id, task_id)
            if (task_root / step_key).is_symlink():
                raise ValueError("Sample directory cannot be a symbolic link")
            number = next_artifact_round(artifacts, workflow_id, task_id, step_key)
            directory = step_round_dir(artifacts, workflow_id, task_id, step_key, number)
            directory.mkdir(parents=True, exist_ok=False)
            created.append(directory)
            for port, content in entries:
                spec = required[(step_key, port)]
                destination = directory.parent / GLOBAL_DIRECTORY if spec.get("global") else directory
                _, output = _output_path(
                    str(destination), str(spec.get("name") or f"产物{port + 1}"), str(spec.get("type") or "file"),
                )
                path = Path(output).resolve()
                if path.name == "manifest.json" or path == destination.resolve() or not path.is_relative_to(destination.resolve()):
                    raise ValueError("Invalid sample artifact path")
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("x", encoding="utf-8") as file:
                    if spec.get("global"):
                        shared_samples.append(path)
                    file.write(content)
            manifest = write_round_manifest(
                artifacts_root=artifacts, workflow_id=workflow_id, task_id=task_id, step_key=step_key,
                artifact_round=number, status="debug_sample", eligible_for_downstream=True, outputs=outputs,
            )
            ready = {item["port"] for item in manifest["outputs"] if item["nonempty"]}
            if any(port not in ready for port, _ in entries):
                raise ValueError("Sample does not match the declared output")
            rounds[step_key] = number
    except Exception:
        for path in shared_samples:
            path.unlink(missing_ok=True)
        for directory in created:
            shutil.rmtree(directory)
        raise
    return rounds


def replace_debug_configuration(project, debug, workflow):
    old = compile_debug(json.loads(debug.steps_json))
    new = compile_debug(workflow)

    def contracts(scheduler):
        return {key: [(item.get("name"), item.get("type")) for item in step.outputs]
                for key, step in scheduler.steps.items()}

    previous, current = contracts(old), contracts(new)
    changed = [key for key, outputs in previous.items() if outputs != current.get(key)]
    if changed:
        artifacts = project.workstep_dir / "artifacts"
        for task in Task.select(Task.id).where(Task.workflow_id == debug.id):
            root = task_artifact_root(project.workstep_dir, debug.id, task.id)
            for key in changed:
                if (root / key).is_symlink():
                    raise ValueError("Artifact step directory cannot be a symbolic link")
                for item in iter_artifact_rounds(artifacts, debug.id, task.id, key):
                    if item.eligible_for_downstream:
                        update_round_manifest_status(
                            artifacts_root=artifacts, workflow_id=debug.id, task_id=task.id,
                            step_key=key, artifact_round=item.round, status=item.status or "stale",
                            eligible_for_downstream=False,
                        )
    debug.steps_json = json.dumps(workflow, ensure_ascii=False)
    debug.updated_at = utc_now()
    debug.save(only=[Workflow.steps_json, Workflow.updated_at])


def save_debug_workflow(project, source_id, workflow):
    _, debug = debug_workflow(source_id)
    if debug is None:
        raise LookupError("Debug workflow not found")
    with project.db.atomic("IMMEDIATE"):
        require_idle(debug)
        replace_debug_configuration(project, debug, workflow)
    ProjectWorkflowService()._sync_project_workflows(project)
    return debug.id


def validate_samples(required, entries, *, require_all=False):
    samples = {(item.step_key, item.port): item.content for item in entries}
    if (len(samples) != len(entries) or not samples.keys() <= required.keys()
            or require_all and samples.keys() != required.keys()
            or any(not value.strip() for value in samples.values())):
        raise ValueError("Provide a non-empty sample for every connected upstream output")
    for key, content in samples.items():
        spec = required[key]
        kind = str(spec.get("type") or "file")
        extension = _artifact_extension(kind, str(spec.get("name") or "")).lower()
        if kind.lower() == "directory" or extension in {".jpg", ".jpeg", ".png", ".pdf", ".docx", ".xlsx"}:
            raise ValueError("This upstream output cannot be entered as a text sample")
        if extension == ".json":
            json.loads(content)
    return samples


def prepare_debug_restart(project, source_id, task_id, step_key, entries):
    _, debug = debug_workflow(source_id)
    task = Task.get_or_none(Task.id == task_id, Task.workflow_id == debug.id) if debug else None
    if task is None:
        raise LookupError("Debug task not found")
    if task_has_active_execution(task):
        raise RuntimeError("Stop the debug task before restarting it")
    scheduler = compile_debug(json.loads(debug.steps_json))
    required = upstream_outputs(scheduler, step_key)
    samples = validate_samples(required, entries)
    artifacts = project.workstep_dir / "artifacts"
    changed_sources = {key for key, _ in samples}
    rounds = {}
    for (key, port), output in required.items():
        if key in changed_sources:
            if (key, port) not in samples:
                raise ValueError(f"Provide all connected outputs for {key} when editing its sample")
            continue
        if key not in rounds:
            previous = select_upstream_round(artifacts, debug.id, task_id, key)
            rounds[key] = previous
        selected = rounds[key]
        if selected is None or source_for_connection({"from": key, "fromPort": port}, selected, output) is None:
            raise ValueError(f"Missing upstream artifact: {key} / {output.get('name', port)}")
    return ({key: item.round for key, item in rounds.items()}
            | write_samples(project, debug.id, task_id, scheduler, required, samples))


def create_debug_task(project, source_id, request, task_service, engine, creator):
    scheduler = compile_debug(request.workflow)
    required = upstream_outputs(scheduler, request.step_key)
    samples = validate_samples(required, request.samples, require_all=True)

    source, debug = debug_workflow(source_id)
    require_idle(debug)
    task_id = None
    try:
        with project.db.atomic("IMMEDIATE"):
            now = utc_now()
            if debug is None:
                debug = Workflow.create(
                    id=new_id(project.id), name=source.name, debug_source_id=source.id,
                    steps_json=json.dumps(request.workflow, ensure_ascii=False), created_at=now, updated_at=now,
                )
            else:
                replace_debug_configuration(project, debug, request.workflow)
            created = task_service.create_task(
                project_id=project.id, title=request.title.strip(), description=request.description,
                cwd=str(project.path), engine=engine, workflow=request.workflow,
                workflow_id=debug.id, start_step_key=request.step_key, creator_fields=creator,
            )
            task_id = created["id"]
            directory = task_artifact_root(project.workstep_dir, debug.id, task_id) / ".debug-workspace"
            directory.mkdir(parents=True, exist_ok=False)
            Task.update(cwd=str(directory)).where(Task.id == task_id).execute()
            rounds = write_samples(project, debug.id, task_id, scheduler, required, samples)
    except Exception:
        if task_id:
            delete_task_artifacts(project.workstep_dir, debug.id, task_id)
        raise
    ProjectWorkflowService()._sync_project_workflows(project)
    return {"id": task_id, "workflow_id": debug.id}, rounds
