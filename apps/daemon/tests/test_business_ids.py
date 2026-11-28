import re
from concurrent.futures import ThreadPoolExecutor

import pytest


def test_project_ids_keep_milliseconds_and_are_monotonic(monkeypatch):
    from services import business_ids

    class Clock:
        def __init__(self):
            self.ms = 1_795_800_000_000

        def time_ns(self):
            return self.ms * 1_000_000

    clock = Clock()
    monkeypatch.setattr(business_ids, "time", clock)
    monkeypatch.setattr(business_ids, "_last_timestamp_ms", -1)
    monkeypatch.setattr(business_ids, "_last_counter", 0)
    first = business_ids.new_id("164938b7")
    second = business_ids.new_id("164938b7")
    clock.ms -= 1
    third = business_ids.new_id("164938b7")
    clock.ms += 2
    fourth = business_ids.new_id("164938b7")

    alphabet = "0123456789abcdefghjkmnpqrstvwxyz"
    timestamp = 0
    for char in first[8:18]:
        timestamp = timestamp * 32 + alphabet.index(char)
    assert timestamp == 1_795_800_000_000
    assert first < second < third < fourth
    assert first[:18] == second[:18] == third[:18] < fourth[:18]
    assert all(re.fullmatch("164938b7[" + alphabet + "]{18}", value) for value in (
        first, second, third, fourth,
    ))


def test_concurrent_project_ids_are_unique():
    from services.business_ids import new_id

    with ThreadPoolExecutor(max_workers=2) as executor:
        ids = list(executor.map(new_id, ["164938b7"] * 2000))
    assert len(set(ids)) == len(ids)
    assert all(len(value) == 26 and value.startswith("164938b7") for value in ids)


def test_host_and_legacy_project_ids_preserve_scope():
    from services.business_ids import new_id

    assert re.fullmatch("[0-9a-f]{8}", new_id(kind="project"))
    assert re.fullmatch("[0-9a-hjkmnp-tv-z]{18}", new_id())
    project = "5739c385-0f1b-4292-bd18-5beeb30f71fa"
    assert new_id(project).rsplit("-", 1)[0] == project


def test_counter_wrap_advances_logical_time(monkeypatch):
    from types import SimpleNamespace

    from services import business_ids

    monkeypatch.setattr(business_ids, "time", SimpleNamespace(time_ns=lambda: 1_000_000))
    monkeypatch.setattr(business_ids, "_last_timestamp_ms", 1)
    monkeypatch.setattr(business_ids, "_last_counter", (1 << 40) - 2)

    assert business_ids.new_id() == "0000000001zzzzzzzz"
    assert business_ids.new_id() == "000000000200000000"


def test_worktree_paths_accept_ids_under_legacy_projects(tmp_path):
    from services.business_ids import new_id
    from services.git.command import GitError
    from services.git.task_workspace import TaskGitWorkspace

    project_id = "legacy_" * 11 + "old"
    assert len(project_id) == 80
    task_id, workflow_id = new_id(project_id), new_id(project_id)
    path = TaskGitWorkspace.root(tmp_path, task_id, workflow_id)
    assert path == tmp_path.resolve() / ".workstep" / "artifacts" / workflow_id / task_id / ".worktrees"
    with pytest.raises(GitError, match="Invalid task ID"):
        TaskGitWorkspace.root(tmp_path, "../other", workflow_id)
