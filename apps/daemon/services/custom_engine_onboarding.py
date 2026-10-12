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


async def create_onboarding() -> dict:
    module = chat_module()
    # Resolve before allocating a project; all configuration and disk reads are
    # isolated from the event loop, as is the complete DB unit below.
    await asyncio.to_thread(module._resolve_engine_models)
    project = await asyncio.to_thread(lambda: runtime_project(project_manager, workspace_parent()))
    root = project.path
    await asyncio.to_thread(skill_center.runtime_selection, root)
    session = await project_manager.run_db(project.id, lambda current: module.create_session(
        project.id, title="自定义引擎接入"))
    prompt = (
        "请协助我接入一个自定义 LLM 执行引擎。先询问引擎名称、官方 SDK/CLI 文档、"
        "认证方式和需要的能力。按 workstep-cli 的引导，按需阅读 references/custom-engine.md "
        "及接口契约后创建适配器，无需加载独立技能。\n"
        f"共享 runtime 工作目录：{root}\n引擎创作根目录：{root}\n"
        "在 Runtime 根目录内自行创建具名引擎包，不覆盖其他已有成果。"
        "先通过 WorkStep CLI 检查是否已接入，避免覆盖现有引擎。依赖安装到每个引擎自己的 dependencies，"
        "不要修改 WorkStep 的 Python 环境。配置密钥通过设置保存。"
        "必须完成真实连接、方法与事件规范测试，通过 engine validate 后才能 register；"
        "只有注册成功且报告通过后，才提示我重启程序。请先帮我补全接入信息。"
    )
    return {"project_id": project.id, "project_name": project.name,
            "session_id": session["id"], "workspace_path": str(root), "package_path": str(root), "prompt": prompt}
