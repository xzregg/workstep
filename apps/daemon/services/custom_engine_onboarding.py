"""Start engine onboarding using the existing ordinary project chat."""
import asyncio
from pathlib import Path

from services.project import project_manager
from services.skill_center import skill_center
from services.customization_workspace import workspace_root, runtime_project


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
    prompt = (
        'Help me integrate a custom LLM execution engine. First ask for its name, official SDK/CLI documentation, '
        'authentication method, and required capabilities. Follow workstep-cli and read references/custom-engine.md '
        'and the adapter contract on demand; no separate skill is needed. '
        f'\nShared Runtime workspace: {root}\nEngine creation root: {root}\n'
        'Create a named engine package within the Runtime root without overwriting existing work. '
        'Check existing engines through WorkStep CLI before changing them. Install dependencies into each engine own dependencies directory; '
        'do not modify WorkStep Python environment. Save credentials through Settings. '
        'Declare supports_mcp honestly; if true, implement async configure_mcp_servers(servers, config_overrides=None), '
        'pass its returned configuration into native SDK/CLI execution and resume without dropping existing MCP servers. '
        'Never put connector credentials in prompts. Pass the real MCP tool-call and resumed-session acceptance checks. '
        'Complete real connection, method, and event contract tests; pass engine validate before register. '
        'Only after successful registration and a passed report, ask me to click Rescan on the Settings engine page; no restart is needed. '
        'Start by helping me complete the onboarding requirements.'
    )
    if package_path:
        prompt = (
            f'Help me install and register an imported custom engine package.\nWorking directory: {root}\nImported package: {package_path}\n'
            'Use workstep-cli to read references/custom-engine.md and the adapter contract on demand. '
            'Use this existing package; do not recreate the adapter. Check its manifest and existing engines first. '
            'If the same engine ID is already registered, ask before replacing it; do not overwrite directly. '
            'Exported packages exclude credentials, dependencies, and local acceptance reports. Install package dependencies '
            'and help configure the provider, authentication, and model through Settings without modifying WorkStep Python environment. '
            'Check supports_mcp and async configure_mcp_servers(servers, config_overrides=None); declared support must '
            'consume MCP configuration in execution and resume, preserve native servers, and pass real MCP tool-call acceptance. '
            'Never put connector credentials in prompts. '
            'Complete real connection, method, and event tests; pass engine validate before register. '
            'After registration, ask me to click Rescan on the Settings engine page; no restart is needed.'
        )
    return {"project_id": project.id, "project_name": project.name,
            "session_id": session["id"], "workspace_path": str(root), "package_path": str(package_path or root), "prompt": prompt}
