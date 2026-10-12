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


async def create_onboarding():
    module = chat_module()
    await asyncio.to_thread(module._resolve_engine_models)
    project = await asyncio.to_thread(lambda: runtime_project(project_manager, workspace_parent()))
    await asyncio.to_thread(skill_center.runtime_selection, project.path)
    session = await project_manager.run_db(project.id, lambda current: module.create_session(project.id, title='自定义技能制作'))
    prompt = (
        '请帮我制作一个自定义技能。先询问用途、触发条件、输入输出和需要的工具。'
        f'\n共享 runtime 工作目录：{project.path}\n技能创作根目录：{project.path}\n'
        '在 Runtime 根目录内自行创建具名技能包，编写 SKILL.md 及 references、scripts、assets 等配套文件，'
        '不修改其他已有成果或已安装技能库。SKILL.md 需要 name 和 description frontmatter，'
        '说明真实使用方法和能力边界，并验证示例。完成后说明安装位置与步骤；'
        '只有用户明确要求安装时才复制到已有技能库，不能把草稿直接作为已安装技能加载。'
    )
    return {'project_id': project.id, 'project_name': project.name, 'session_id': session['id'],
            'workspace_path': str(project.path), 'package_path': str(project.path), 'prompt': prompt}
