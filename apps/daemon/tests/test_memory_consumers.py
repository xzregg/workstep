"""Project-memory consumers must keep reads and archive rollback in the data root."""

from types import SimpleNamespace

import pytest

from services.prompt import _load_project_memory
from services.task_archive import persist_experience_and_archive


@pytest.mark.parametrize("linked", [False, True])
def test_prompt_memory_preserves_regular_files_and_in_root_links(tmp_path, linked):
    data = tmp_path / "data"
    data.mkdir()
    memory = data / "MEMORY.md"
    if linked:
        target = data / "memory-content.md"
        target.write_text("  已有约定  ", encoding="utf-8")
        memory.symlink_to(target)
    else:
        memory.write_text("  已有约定  ", encoding="utf-8")
    assert _load_project_memory(data / "artifacts", limit=3) == "已有约"


def test_prompt_memory_does_not_include_outside_symlink_target(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    outside = tmp_path / "private.md"
    outside.write_text("OUTSIDE_PRIVATE_CONTENT", encoding="utf-8")
    (data / "MEMORY.md").symlink_to(outside)
    content = _load_project_memory(data / "artifacts")
    print("PPV_REACHED", flush=True)
    assert content is None


def test_prompt_memory_preserves_universal_newline_and_limit(tmp_path):
    (tmp_path / "MEMORY.md").write_bytes(b"first\r\nsecond\rthird")
    assert _load_project_memory(tmp_path / "artifacts") == "first\nsecond\nthird"
    assert _load_project_memory(tmp_path / "artifacts", limit=12) == "first\nsecond"


@pytest.fixture
def archive_task(monkeypatch):
    import models

    task = SimpleNamespace(archived=False, status="pending", title="经验任务")
    monkeypatch.setattr(models, "Task", SimpleNamespace(
        id="id", get_or_none=lambda _condition: task,
    ))
    return task


@pytest.mark.parametrize("linked", [False, True])
@pytest.mark.parametrize("failure", [False, True])
def test_archive_memory_append_and_rollback_preserve_allowed_targets(
    tmp_path, archive_task, linked, failure,
):
    data = tmp_path / "data"
    data.mkdir()
    memory = data / "MEMORY.md"
    target = data / "content.md" if linked else memory
    target.write_bytes("已有经验\n".encode())
    if linked:
        memory.symlink_to(target)

    def archive(*_args):
        if failure:
            raise RuntimeError("archive failed")
        return True

    project = SimpleNamespace(workstep_dir=data)
    service = SimpleNamespace(archive_task=archive)
    if failure:
        with pytest.raises(RuntimeError, match="archive failed"):
            persist_experience_and_archive(project, service, "pid", "tid", "新经验")
        assert target.read_bytes() == "已有经验\n".encode()
    else:
        assert persist_experience_and_archive(project, service, "pid", "tid", "新经验")
        assert target.read_text() == "已有经验\n\n## 错误经验：经验任务\n\n新经验\n"
    assert memory.is_symlink() is linked


def test_archive_memory_failure_removes_new_file(tmp_path, archive_task):
    data = tmp_path / "data"
    data.mkdir()

    def archive(*_args):
        raise RuntimeError("archive failed")

    with pytest.raises(RuntimeError, match="archive failed"):
        persist_experience_and_archive(
            SimpleNamespace(workstep_dir=data), SimpleNamespace(archive_task=archive),
            "pid", "tid", "新经验",
        )
    assert not (data / "MEMORY.md").exists()


def test_archive_memory_rejects_external_link_before_archiving(tmp_path, archive_task):
    data = tmp_path / "data"
    data.mkdir()
    outside = tmp_path / "private.md"
    outside.write_bytes(b"OUTSIDE_PRIVATE_CONTENT")
    (data / "MEMORY.md").symlink_to(outside)
    called = []
    error = None
    try:
        persist_experience_and_archive(
            SimpleNamespace(workstep_dir=data),
            SimpleNamespace(archive_task=lambda *_args: called.append(True)),
            "pid", "tid", "新经验",
        )
    except Exception as exc:
        error = exc
    print("PPV_REACHED", flush=True)
    assert isinstance(error, PermissionError)
    assert called == []
    assert outside.read_bytes() == b"OUTSIDE_PRIVATE_CONTENT"
    assert (data / "MEMORY.md").is_symlink()
