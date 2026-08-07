"""Skills — discover Claude Code / Codex style skills for the built-in agent."""

from dataclasses import dataclass
from pathlib import Path

DEFAULT_SKILL_DIRS = [
    Path.home() / ".claude" / "skills",
    Path.home() / ".codex" / "skills",
    Path.home() / ".agents" / "skills",
]

PROJECT_SKILL_DIRS = [".claude/skills", ".codex/skills"]


def _parse_frontmatter(content: str) -> dict:
    """Minimal YAML-ish frontmatter parser for name/description.

    Supports single-line values and folded/literal multi-line scalars
    (``description: >`` / ``description: |``) used by Claude Code skills.
    """
    meta: dict = {}
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return meta
    current_key: str | None = None
    current_mode: str | None = None  # None | "fold" | "literal"
    buffer: list[str] = []

    def flush_block() -> None:
        nonlocal current_key, current_mode, buffer
        if current_mode is not None and current_key is not None and buffer:
            value = " ".join(buffer) if current_mode == "fold" else "\n".join(buffer)
            meta[current_key] = value.strip()
        current_key = None
        current_mode = None
        buffer = []

    for line in lines[1:]:
        if line.strip() == "---":
            break
        if current_mode is not None:
            if line[:1] in {" ", "\t"}:
                buffer.append(line.strip())
                continue
            flush_block()
            if ":" not in line:
                continue
        if ":" in line:
            key, _, raw_value = line.partition(":")
            key = key.strip()
            raw_value = raw_value.strip()
            if raw_value in {">", "|"}:
                current_key = key
                current_mode = "fold" if raw_value == ">" else "literal"
                buffer = []
            else:
                meta[key] = raw_value.strip("'\"")
    flush_block()
    return meta


def _strip_frontmatter(content: str) -> str:
    lines = content.splitlines()
    if lines and lines[0].strip() == "---":
        for index in range(1, len(lines)):
            if lines[index].strip() == "---":
                return "\n".join(lines[index + 1:]).strip()
    return content.strip()


@dataclass(frozen=True)
class Skill:
    """A local skill: a directory containing a SKILL.md manifest."""

    name: str
    description: str
    source_dir: Path
    skill_dir: Path

    def to_markdown(self) -> str:
        """Render the skill as standalone instructions for the agent."""
        markdown = self.skill_dir / "SKILL.md"
        content = markdown.read_text(encoding="utf-8", errors="replace")
        text = f"# Skill: {self.name}\n"
        if self.description:
            text += f"> {self.description}\n"
        body = _strip_frontmatter(content)
        text += f"\n{body}\n"
        return text


class Skills:
    """Registry over local SKILL.md directories.

    Default search order is Claude Code, Codex, then ~/.agents; later
    directories override earlier ones so personal skills win over bundled ones.
    """

    def __init__(
        self,
        directories: list[str | Path] | None = None,
        *,
        project_root: str | Path | None = None,
    ):
        """Scan the given directories (default: Claude Code / Codex / ~/.agents
        home skill dirs), optionally extended with the project-local
        ``<root>/.claude/skills`` and ``<root>/.codex/skills`` directories.

        Later directories override earlier ones, so project-scoped skills win
        over personal skills with the same name.
        """
        selected = (
            list(directories)
            if directories is not None
            else list(DEFAULT_SKILL_DIRS)
        )
        if project_root is not None:
            root = Path(project_root).expanduser()
            selected.extend(root / subdir for subdir in PROJECT_SKILL_DIRS)
        self.directories = [Path(directory).expanduser() for directory in selected]

    def _discover(self) -> dict[str, Skill]:
        found: dict[str, Skill] = {}
        for directory in self.directories:
            if not directory.is_dir():
                continue
            for skill_dir in sorted(directory.iterdir()):
                if not skill_dir.is_dir():
                    continue
                markdown = skill_dir / "SKILL.md"
                if not markdown.is_file():
                    continue
                content = markdown.read_text(encoding="utf-8", errors="replace")
                meta = _parse_frontmatter(content)
                name = meta.get("name") or skill_dir.name
                found[name] = Skill(
                    name=name,
                    description=meta.get("description", ""),
                    source_dir=directory,
                    skill_dir=skill_dir,
                )
        return found

    def list_skills(self) -> list[Skill]:
        """Return all discovered skills, sorted by name."""
        return sorted(self._discover().values(), key=lambda skill: skill.name)

    def names(self) -> list[str]:
        return [skill.name for skill in self.list_skills()]

    def get(self, name: str) -> Skill | None:
        """Look up a skill by name (case-insensitive)."""
        for skill in self.list_skills():
            if skill.name.lower() == name.lower():
                return skill
        return None

    def load(self, name: str) -> str:
        """Load a skill's full instructions; raise a helpful error when missing."""
        skill = self.get(name)
        if skill is None:
            raise ValueError(f"技能不存在: {name}。可用: {', '.join(self.names())}")
        return skill.to_markdown()
