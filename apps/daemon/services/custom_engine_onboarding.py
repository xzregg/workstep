"""Start engine onboarding using the existing ordinary project chat."""
import asyncio
from pathlib import Path

from services.project import project_manager
from services.skill_center import skill_center
from services.customization_workspace import workspace_root, runtime_project


ENGINE_ONBOARDING_GUIDANCE = (
    'Follow workstep-cli. Read references/custom-engine.md for the CLI workflow, '
    'references/custom-engine-contract.md for adapter interfaces, and '
    'references/custom-engine-testing.md for required tests and acceptance evidence. '
    'Check existing engines first; declare only implemented native capabilities and permissions. '
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


async def create_onboarding(package_path: Path | None = None, title: str | None = None) -> dict:
    module = chat_module()
    # Resolve before allocating a project; all configuration and disk reads are
    # isolated from the event loop, as is the complete DB unit below.
    await asyncio.to_thread(module._resolve_engine_models)
    project = await asyncio.to_thread(lambda: runtime_project(project_manager, workspace_parent()))
    root = project.path
    await asyncio.to_thread(skill_center.runtime_selection, root)
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
    prompt = request + f'Shared Runtime workspace: {root}\n' + ENGINE_ONBOARDING_GUIDANCE
    return {"project_id": project.id, "project_name": project.name,
            "session_id": session["id"], "workspace_path": str(root), "package_path": str(package_path or root), "prompt": prompt}
