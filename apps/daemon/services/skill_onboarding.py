"""Skill drafts use the shared runtime project, never the installed skill roots."""
import asyncio

from services.project import project_manager
from services.skill_center import skill_center
from services.customization_workspace import workspace_root, runtime_project


def chat_module():
    from services.custom_engine_onboarding import chat_module as resolve
    return resolve()


def workspace_parent():
    return workspace_root()


async def create_onboarding(title: str | None = None):
    module = chat_module()
    await asyncio.to_thread(module._resolve_engine_models)
    project = await asyncio.to_thread(lambda: runtime_project(project_manager, workspace_parent()))
    await asyncio.to_thread(skill_center.runtime_selection, project.path)
    session = await project_manager.run_db(project.id, lambda current: module.create_session(project.id, title=title or '自定义技能制作'))
    prompt = (
        'Help me create a custom skill. First ask about its purpose, trigger conditions, inputs, outputs, and required tools.'
        f'\nShared Runtime workspace: {project.path}\nSkill creation root: {project.path}\n'
        'Create a named skill package within the Runtime root, with SKILL.md and any required references, scripts, and assets. '
        'Do not modify other existing work or installed skill libraries. SKILL.md requires name and description frontmatter. '
        'Describe actual usage and capability boundaries, and validate examples. Explain the installation location and steps when done. '
        'Copy into an existing skill library only if the user explicitly requests installation; do not load drafts as installed skills.'
    )
    return {'project_id': project.id, 'project_name': project.name, 'session_id': session['id'],
            'workspace_path': str(project.path), 'package_path': str(project.path), 'prompt': prompt}
