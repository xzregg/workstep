"""Task-owned collections of Git worktrees below a project's .workstep directory."""

import asyncio
import re
from pathlib import Path

from . import identity
from .command import GitError, text


ALIAS = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
DEFAULT_COMMIT_EMAIL = "you@example.com"


class TaskGitWorkspace:
    def __init__(self, git_service):
        self.git = git_service

    def _lock(self, project_path: str | Path, task_id: str) -> asyncio.Lock:
        return self.git.locks.setdefault(f"workspace:{project_path}:{task_id}", asyncio.Lock())

    @staticmethod
    def root(project_path: str | Path, task_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9-]{1,80}", task_id):
            raise GitError("无效的任务 ID。")
        project = Path(project_path).resolve()
        workstep = project / ".workstep"
        if workstep.is_symlink():
            raise GitError("项目元数据目录不能是符号链接。", 409)
        container = workstep / "worktrees"
        if container.is_symlink():
            raise GitError("任务工作区目录不能是符号链接。", 409)
        target = container / task_id
        if target.is_symlink():
            raise GitError("任务目录不能是符号链接。", 409)
        return target

    def _project_repositories(self, project_path: Path):
        return {
            repo["id"]: repo
            for repo in self.git.snapshot["repositories"]
            if any(
                Path(project["path"]).resolve() == project_path
                for project in self.git.snapshot["projects"]
                for membership in repo["projects"]
                if membership["id"] == project["id"]
            )
        }

    async def ensure(self, project_path: str | Path, task_id: str, *, creator_name: str = "") -> dict:
        async with self._lock(project_path, task_id):
            root = await asyncio.to_thread(self.root, project_path, task_id)
            await asyncio.to_thread(root.mkdir, parents=True, exist_ok=True)
            workspace = await self.list(project_path, task_id)
            for tree in workspace["worktrees"]:
                path = tree["path"]
                common = self.git.directories[tree["id"]]["common_dir"]
                async with self.git.locks.setdefault(common, asyncio.Lock()):
                    await self.git.command(path, "config", "extensions.worktreeConfig", "true")
                    email_raw, _ = await self.git.command(path, "config", "--get", "user.email", check=False)
                    await self._configure_identity(path, creator_name, text(email_raw).strip() or DEFAULT_COMMIT_EMAIL)
            return workspace

    async def _configure_identity(self, path: str | Path, creator_name: str, email: str) -> None:
        shared_raw, _ = await self.git.command(path, "config", "--local", "--get", "workstep.sharedIdentity", check=False)
        if text(shared_raw).strip() == "true":
            shared_name, _ = await self.git.command(path, "config", "--local", "--get", "user.name", check=False)
            shared_email, _ = await self.git.command(path, "config", "--local", "--get", "user.email", check=False)
            creator_name = text(shared_name).strip()
            email = text(shared_email).strip()
        name_raw, _ = await self.git.command(path, "config", "--worktree", "--get", "user.name", check=False)
        if creator_name.strip() and not text(name_raw).strip():
            await self.git.command(path, "config", "--worktree", "user.name", creator_name.strip())
        email_raw, _ = await self.git.command(path, "config", "--worktree", "--get", "user.email", check=False)
        if not text(email_raw).strip():
            await self.git.command(path, "config", "--worktree", "user.email", email)

    async def list(self, project_path: str | Path, task_id: str) -> dict:
        root = await asyncio.to_thread(self.root, project_path, task_id)
        if not await asyncio.to_thread(root.is_dir):
            return {"path": str(root), "worktrees": []}
        project = await asyncio.to_thread(Path(project_path).resolve)
        repos = await asyncio.to_thread(self._project_repositories, project)
        by_common = {repo["common_dir"]: repo for repo in repos.values()}
        entries = await asyncio.to_thread(lambda: sorted(root.iterdir()))
        result = []
        for entry in entries:
            if not await asyncio.to_thread(lambda p=entry: p.is_dir() and not p.is_symlink()):
                continue
            raw, code = await self.git.command(entry, "rev-parse", "--path-format=absolute", "--git-common-dir", check=False)
            if code:
                continue
            common = str(await asyncio.to_thread(Path(text(raw).strip()).resolve))
            repo = by_common.get(common)
            if not repo:
                continue
            discovered = await self.git.discover_repository(entry)
            tree = next((item for item in discovered["worktrees"] if Path(item["path"]).resolve() == entry.resolve()), None)
            if tree is None:
                continue
            self.git.directories[tree["id"]] = {**tree, "repo_id": repo["id"], "common_dir": common,
                "project_ids": [m["id"] for m in repo["projects"]]}
            result.append({"alias": entry.name, "repository_id": repo["id"], "repository_name": repo["name"], **tree})
        return {"path": str(root), "worktrees": result}

    async def add(self, project_path: str | Path, task_id: str, repository_id: str, alias: str, base_ref: str, branch_name: str | None = None, *, creator_name: str = "") -> dict:
        async with self._lock(project_path, task_id):
            return await self._add(project_path, task_id, repository_id, alias, base_ref, branch_name, creator_name)

    async def _add(self, project_path: str | Path, task_id: str, repository_id: str, alias: str, base_ref: str, branch_name: str | None, creator_name: str) -> dict:
        if not ALIAS.fullmatch(alias) or alias in {".", ".."}:
            raise GitError("无效的工作目录名称。")
        if not base_ref or base_ref.startswith("-") or "\0" in base_ref:
            raise GitError("无效的基准分支。")
        project = await asyncio.to_thread(Path(project_path).resolve)
        repo = (await asyncio.to_thread(self._project_repositories, project)).get(repository_id)
        if not repo:
            raise GitError("仓库不属于当前项目，请重新扫描。", 404)
        project_ids = {p["id"] for p in self.git.snapshot["projects"] if Path(p["path"]).resolve() == project}
        source = next((project / m["relative_path"] for m in repo["projects"]
                       if m["id"] in project_ids and (project / m["relative_path"]).is_dir()), None)
        if source is None:
            raise GitError("源仓库目录已不存在。", 404)
        actual_source = await asyncio.to_thread(source.resolve)
        if not actual_source.is_relative_to(project):
            raise GitError("源仓库已越过项目目录。", 409)
        raw, _ = await self.git.command(source, "rev-parse", "--path-format=absolute", "--git-common-dir")
        actual_common = str(await asyncio.to_thread(Path(text(raw).strip()).resolve))
        if actual_common != repo["common_dir"]:
            raise GitError("源仓库已变化，请重新扫描。", 409)
        root = await asyncio.to_thread(self.root, project, task_id)
        target = root / alias
        lock = self.git.locks.setdefault(repo["common_dir"], asyncio.Lock())
        async with lock:
            current = await self.list(project, task_id)
            if any(tree["repository_id"] == repository_id for tree in current["worktrees"]):
                raise GitError("此任务已经有该仓库的 Worktree。", 409)
            if await asyncio.to_thread(target.exists) or await asyncio.to_thread(target.is_symlink):
                raise GitError("任务目录中已存在同名工作目录。", 409)
            sha = await self.git.revision(str(source), base_ref)
            if not sha:
                raise GitError("基准分支尚无提交。", 409)
            default_branch = f"workstep/{task_id}/{alias}"
            branch = default_branch if branch_name is None else branch_name
            if not branch or branch.startswith("-") or "\0" in branch:
                raise GitError("功能分支名称无效。")
            _, code = await self.git.command(source, "check-ref-format", "--branch", branch, check=False)
            if code:
                raise GitError("功能分支名称无效。")
            _, code = await self.git.command(source, "show-ref", "--verify", "--quiet", "refs/heads/" + branch, check=False)
            if not code and branch != default_branch:
                raise GitError("功能分支已存在，请填写新的分支名。", 409)
            email_raw, _ = await self.git.command(source, "config", "--get", "user.email", check=False)
            email = text(email_raw).strip() or DEFAULT_COMMIT_EMAIL
            await self.git.command(source, "config", "extensions.worktreeConfig", "true")
            await asyncio.to_thread(root.mkdir, parents=True, exist_ok=True)
            if code:
                await self.git.command(source, "worktree", "add", "-b", branch, str(target), sha, timeout=120)
            else:
                occupied = next((tree for tree in repo["worktrees"] if tree["branch"] == branch and tree["available"]), None)
                if occupied:
                    raise GitError("此任务的功能分支已在其他工作目录检出。", 409)
                await self.git.command(source, "worktree", "add", str(target), branch, timeout=120)
            await self._configure_identity(target, creator_name, email)
            discovered = await self.git.discover_repository(source)
            repo["worktrees"] = discovered["worktrees"]
            tree = next(item for item in discovered["worktrees"] if item["id"] == identity(str(target)))
            self.git.directories[tree["id"]] = {**tree, "repo_id": repo["id"], "common_dir": repo["common_dir"],
                "project_ids": [m["id"] for m in repo["projects"]]}
        return await self.list(project, task_id)

    async def remove(self, project_path: str | Path, task_id: str, alias: str) -> dict:
        async with self._lock(project_path, task_id):
            return await self._remove(project_path, task_id, alias)

    async def _remove(self, project_path: str | Path, task_id: str, alias: str) -> dict:
        if not ALIAS.fullmatch(alias) or alias in {".", ".."}:
            raise GitError("无效的工作目录名称。")
        project = await asyncio.to_thread(Path(project_path).resolve)
        root = await asyncio.to_thread(self.root, project, task_id)
        current = await self.list(project, task_id)
        tree = next((item for item in current["worktrees"] if item["alias"] == alias), None)
        if tree is None:
            raise GitError("任务 Worktree 不存在。", 404)
        repo = (await asyncio.to_thread(self._project_repositories, project))[tree["repository_id"]]
        lock = self.git.locks.setdefault(repo["common_dir"], asyncio.Lock())
        async with lock:
            target = root / alias
            raw, _ = await self.git.command(target, "status", "--porcelain=v1", "-z", "--untracked-files=all")
            if raw:
                raise GitError("工作目录存在未提交内容，请先处理后再移除。", 409)
            source = next((item["path"] for item in repo["worktrees"] if item["main"] and item["available"]), None)
            if source is None:
                raise GitError("源仓库目录不可用，请重新扫描。", 409)
            await self.git.command(source, "worktree", "remove", str(target), timeout=120)
            repo["worktrees"] = (await self.git.discover_repository(Path(source)))["worktrees"]
            self.git.directories.pop(tree["id"], None)
        return await self.list(project, task_id)

    async def delete(self, project_path: str | Path, task_id: str) -> dict:
        """Remove only clean, recognized worktrees; keep their Git branches."""
        async with self._lock(project_path, task_id):
            root = await asyncio.to_thread(self.root, project_path, task_id)
            if not await asyncio.to_thread(root.is_dir):
                raise GitError("任务 Git 工作区不存在。", 404)
            current = await self.list(project_path, task_id)
            entries = await asyncio.to_thread(lambda: {entry.name for entry in root.iterdir()})
            aliases = {tree["alias"] for tree in current["worktrees"]}
            if entries != aliases:
                raise GitError("工作区内存在未识别的文件或目录，请先手动处理。", 409)
            project = await asyncio.to_thread(Path(project_path).resolve)
            repos = await asyncio.to_thread(self._project_repositories, project)
            for tree in current["worktrees"]:
                if tree["locked"] or tree["prunable"] or not tree["available"]:
                    raise GitError("工作区包含不可安全移除的 Worktree。", 409)
                repo = repos.get(tree["repository_id"])
                if not repo or not any(item["main"] and item["available"] for item in repo["worktrees"]):
                    raise GitError("源仓库目录不可用，请重新扫描。", 409)
                raw, _ = await self.git.command(tree["path"], "status", "--porcelain=v1", "-z", "--untracked-files=all")
                if raw:
                    raise GitError("工作区存在未提交内容，请先处理后再删除。", 409)
            for tree in current["worktrees"]:
                await self._remove(project_path, task_id, tree["alias"])
            try:
                await asyncio.to_thread(root.rmdir)
            except OSError as exc:
                raise GitError("工作区目录未清空，请检查后重试。", 409) from exc
            return {"path": str(root), "worktrees": []}
