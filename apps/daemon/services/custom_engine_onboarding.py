"""Start engine onboarding using the existing ordinary project chat."""
import asyncio
import os
import shlex
import sys
from pathlib import Path

from services.project import project_manager
from services.skill_center import BUILTIN_SKILLS_DIR, skill_center
from services.customization_workspace import workspace_root, runtime_project


ENGINE_ONBOARDING_GUIDANCE = (
    'Follow workstep-cli. Read references/custom-engine.md for the CLI workflow, '
    'references/custom-engine-contract.md for adapter interfaces, and '
    'references/custom-engine-testing.md for required tests and acceptance evidence. '
    'Check existing engines first; declare only implemented native capabilities and permissions. '
    'If account quota is available, implement SUPPORTS_QUOTA and get_quota in the adapter; '
    'own any API or script collection there, following the quota contract. '
    'Keep dependencies in this engine own directory, do not modify WorkStep Python environment, '
    'and save credentials through Settings. '
    'Pass engine validate before engine register; changes require validation again. '
    'After successful registration, ask me to click Rescan on the Settings engine page; no restart is needed.'
)


def chat_module():
    from main import chat_session_module
    if chat_session_module is None:
        raise ValueError('Chat sessions are not initialized')
    return chat_session_module


def workspace_parent() -> Path:
    return workspace_root()


def cli_invocation() -> str:
    """Resolve a credential-free command that also works in stripped shells."""
    from services.config import CONFIG_DIR
    from services.local_cli import local_origin
    url = local_origin(os.environ.get('WORKSTEP_DAEMON_URL', ''))
    script = Path(__file__).resolve().parent.parent / 'cli.py'
    if not url or not script.is_file() or not Path(sys.executable).is_file():
        raise ValueError('WorkStep CLI runtime is unavailable')
    arguments = [sys.executable, str(script), '--url', url]
    if os.name == 'nt':
        quote = lambda value: "'" + str(value).replace("'", "''") + "'"
        return f"$env:WORKSTEP_CONFIG_DIR={quote(CONFIG_DIR)}; & " + ' '.join(quote(value) for value in arguments)
    return shlex.join(['env', f'WORKSTEP_CONFIG_DIR={CONFIG_DIR}', *arguments])


async def create_onboarding(package_path: Path | None = None, title: str | None = None) -> dict:
    module = chat_module()
    # Resolve before allocating a project; all configuration and disk reads are
    # isolated from the event loop, as is the complete DB unit below.
    await asyncio.to_thread(module._resolve_engine_models)
    project = await asyncio.to_thread(lambda: runtime_project(project_manager, workspace_parent()))
    root = project.path
    def resolve_skill():
        selection = skill_center.runtime_selection(root)
        skill = next((item for item in getattr(selection, 'enabled', ()) if item.name == 'workstep-cli'), None)
        directory = skill.runtime_path if skill and skill.runtime_path else BUILTIN_SKILLS_DIR / 'workstep-cli'
        path = directory / 'SKILL.md'
        required = [path, *(directory / 'references' / name for name in (
            'custom-engine.md', 'custom-engine-contract.md', 'custom-engine-testing.md'))]
        if not all(file.is_file() for file in required):
            raise ValueError('WorkStep CLI engine guides are missing')
        return path.resolve()
    skill_path = await asyncio.to_thread(resolve_skill)
    cli_command = await asyncio.to_thread(cli_invocation)
    session = await project_manager.run_db(project.id, lambda current: module.create_session(
        project.id, title=title or ("导入自定义引擎" if package_path else "自定义引擎接入")))
    if package_path:
        request = (
            'Help me install and register an imported custom engine. Use this existing package; '
            'do not recreate the adapter. If the same engine ID is registered, replace it only '
            'when I have authorized the update.\n'
            f'Imported package: {package_path}\n'
        )
    else:
        request = (
            'Help me integrate a custom LLM execution engine. First confirm its name, official '
            'SDK/CLI documentation, authentication, target platforms, and required capabilities. '
            'Create a named package in the Runtime root without overwriting existing work.\n'
        )
    prompt = request + f'Shared Runtime workspace: {root}\nWorkStep CLI skill: {skill_path}\nCLI: {cli_command} engine list --json\n' + ENGINE_ONBOARDING_GUIDANCE
    return {"project_id": project.id, "project_name": project.name,
            "session_id": session["id"], "workspace_path": str(root), "package_path": str(package_path or root), "skill_path": str(skill_path), "cli_command": cli_command, "prompt": prompt}
