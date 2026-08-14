"""Pydantic AI filesystem tools stay inside their explicitly allowed roots."""

import pytest

from engines.pydantic_ai.filesystem import FileSystem


def test_search_files_does_not_follow_symlink_outside_allowed_root(tmp_path):
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    (outside / "secret.txt").write_text("private-token", encoding="utf-8")
    (project / "linked-secret.txt").symlink_to(outside / "secret.txt")

    filesystem = FileSystem([project])

    assert filesystem.search("private-token") == []


def test_list_files_does_not_expose_symlink_outside_allowed_root(tmp_path):
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    (project / "inside.txt").write_text("safe", encoding="utf-8")
    (outside / "secret.txt").write_text("private", encoding="utf-8")
    (project / "linked-secret.txt").symlink_to(outside / "secret.txt")

    filesystem = FileSystem([project])

    assert filesystem.list_files() == ["inside.txt"]


def test_read_write_and_edit_reject_paths_outside_allowed_root(tmp_path):
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    secret = outside / "secret.txt"
    secret.write_text("private", encoding="utf-8")
    filesystem = FileSystem([project])

    with pytest.raises(ValueError, match="路径不在允许的项目目录中"):
        filesystem.read("../outside/secret.txt")
    with pytest.raises(ValueError, match="路径不在允许的项目目录中"):
        filesystem.write(str(outside / "created.txt"), "escaped")
    with pytest.raises(ValueError, match="路径不在允许的项目目录中"):
        filesystem.edit(str(secret), "private", "changed")

    assert not (outside / "created.txt").exists()
    assert secret.read_text(encoding="utf-8") == "private"


def test_explicit_additional_root_is_accessible_without_opening_other_paths(tmp_path):
    project = tmp_path / "project"
    shared = tmp_path / "shared"
    outside = tmp_path / "outside"
    project.mkdir()
    shared.mkdir()
    outside.mkdir()
    (shared / "allowed.txt").write_text("shared", encoding="utf-8")
    (outside / "secret.txt").write_text("private", encoding="utf-8")
    filesystem = FileSystem([project, shared])

    assert filesystem.read(str(shared / "allowed.txt")) == "shared"
    with pytest.raises(ValueError, match="路径不在允许的项目目录中"):
        filesystem.read(str(outside / "secret.txt"))
