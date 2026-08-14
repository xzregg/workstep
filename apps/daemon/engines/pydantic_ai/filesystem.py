"""FileSystem — sandboxed read/write access for the built-in Pydantic agent."""

from pathlib import Path
from typing import Iterable

MAX_READ_BYTES = 2_000_000
MAX_SEARCH_BYTES = 1_000_000


class FileSystem:
    """Access project files, restricted to a set of allowed roots.

    Every operation resolves symlinks and rejects paths escaping the roots,
    so agent tools can never read or modify files outside the active project.
    """

    def __init__(self, roots: Iterable[str | Path]):
        self.roots = [Path(path).expanduser().resolve() for path in roots]

    def resolve(self, raw_path: str) -> Path:
        """Resolve a raw path against the allowed roots; raise if it escapes."""
        requested = Path(raw_path).expanduser()
        candidates = (
            [requested.resolve()]
            if requested.is_absolute()
            else [(root / requested).resolve() for root in self.roots]
        )
        for candidate in candidates:
            if any(candidate.is_relative_to(root) for root in self.roots):
                return candidate
        raise ValueError("路径不在允许的项目目录中")

    def _display(self, path: Path) -> str:
        for root in self.roots:
            if path.is_relative_to(root):
                relative = path.relative_to(root)
                return str(relative) if relative != Path(".") else "."
        return str(path)

    def list_files(self, path: str = ".", recursive: bool = False) -> list[str]:
        """List files below a directory, capped at 500 entries."""
        directory = self.resolve(path)
        if not directory.is_dir():
            raise ValueError(f"目录不存在: {path}")
        iterator = directory.rglob("*") if recursive else directory.iterdir()
        files = []
        for item in iterator:
            try:
                resolved_item = self.resolve(str(item))
            except ValueError:
                continue
            if resolved_item.is_file():
                files.append(self._display(item))
            if len(files) >= 500:
                break
        return sorted(files)

    def read(self, path: str, start_line: int = 1, end_line: int = 400) -> str:
        """Read a UTF-8 project file within an inclusive line range."""
        file_path = self.resolve(path)
        if not file_path.is_file():
            raise ValueError(f"文件不存在: {path}")
        if file_path.stat().st_size > MAX_READ_BYTES:
            raise ValueError("文件超过 2 MB，请缩小读取范围或使用搜索工具")
        if start_line < 1 or end_line < start_line:
            raise ValueError("行号范围无效")
        lines = file_path.read_text(encoding="utf-8").splitlines()
        return "\n".join(lines[start_line - 1:end_line])

    def write(self, path: str, content: str) -> str:
        """Create or overwrite a UTF-8 project file, creating parent dirs."""
        file_path = self.resolve(path)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")
        return f"已写入 {self._display(file_path)}"

    def edit(
        self,
        path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> str:
        """Replace old_string with new_string in a project file."""
        file_path = self.resolve(path)
        if not file_path.is_file():
            raise ValueError(f"文件不存在: {path}")
        content = file_path.read_text(encoding="utf-8")
        occurrences = content.count(old_string)
        if occurrences == 0:
            raise ValueError(f"未在 {self._display(file_path)} 中找到目标文本")
        if occurrences > 1 and not replace_all:
            raise ValueError(
                f"目标文本出现 {occurrences} 次，请提供更精确的上下文，或设置 replace_all=true"
            )
        updated = content.replace(old_string, new_string) if replace_all else content.replace(old_string, new_string, 1)
        file_path.write_text(updated, encoding="utf-8")
        return f"已更新 {self._display(file_path)}（替换 {occurrences if replace_all else 1} 处）"

    def search(self, query: str, path: str = ".", max_results: int = 100) -> list[str]:
        """Search text in project files and return up to max_results line matches."""
        directory = self.resolve(path)
        if not directory.is_dir():
            raise ValueError(f"目录不存在: {path}")
        matches = []
        for file_path in directory.rglob("*"):
            try:
                file_path = self.resolve(str(file_path))
            except ValueError:
                continue
            if not file_path.is_file() or file_path.stat().st_size > MAX_SEARCH_BYTES:
                continue
            try:
                lines = file_path.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeDecodeError):
                continue
            for line_number, line in enumerate(lines, 1):
                if query in line:
                    matches.append(f"{self._display(file_path)}:{line_number}: {line[:500]}")
                    if len(matches) >= max_results:
                        return matches
        return matches

    def exists(self, path: str) -> bool:
        try:
            return self.resolve(path).exists()
        except ValueError:
            return False

    def is_dir(self, path: str) -> bool:
        try:
            return self.resolve(path).is_dir()
        except ValueError:
            return False
