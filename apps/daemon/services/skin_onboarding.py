"""Create a skin design workspace using ordinary project chat."""
import asyncio
import json
import tempfile
import uuid
from pathlib import Path
from models.chat_session import ChatSession, ProjectSetting
from models.fields import utc_now

from services.project import project_manager
from services.skill_center import skill_center
from services.skins import read_contract
from services.customization_workspace import workspace_root, runtime_project


def chat_module():
    from services.custom_engine_onboarding import chat_module as resolve
    return resolve()


def workspace_parent():
    return workspace_root()


def prepare(root, prompt):
    root.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=root, prefix='.skin-contract-', delete=False) as file:
            temporary = Path(file.name)
            file.write(json.dumps(read_contract(), ensure_ascii=False, indent=2))
        temporary.replace(root / 'skin-contract.json')
        (root / 'skin-design.md').write_text(prompt, encoding='utf-8')
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)


def design_session(project, module):
    """Run in the project's DB executor; keep identity across rename/restart."""
    setting = ProjectSetting.get_or_none(ProjectSetting.project_id == project.id, ProjectSetting.key == 'skin_design_session')
    session_id = json.loads(setting.value_json) if setting else None
    row = ChatSession.get_or_none(ChatSession.id == session_id, ChatSession.archived == False) if session_id else None
    if row is None:
        row = ChatSession.select().where(ChatSession.title == '自定义皮肤设计', ChatSession.archived == False).order_by(ChatSession.updated_at.desc()).first()
    created = row is None
    session_id = module.create_session(project.id, title='自定义皮肤设计')['id'] if created else row.id
    if setting:
        setting.value_json = json.dumps(session_id)
        setting.updated_at = utc_now()
        setting.save()
    else:
        ProjectSetting.create(id=str(uuid.uuid4()), project_id=project.id, key='skin_design_session', value_json=json.dumps(session_id), updated_at=utc_now())
    return {'id': session_id, 'created': created}


async def create_onboarding():
    module = chat_module()
    await asyncio.to_thread(module._resolve_engine_models)
    project = await asyncio.to_thread(lambda: runtime_project(project_manager, workspace_parent()))
    root = project.path
    await asyncio.to_thread(skill_center.runtime_selection, root)
    session = await project_manager.run_db(project.id, lambda current: design_session(current, module))
    prompt = ("请帮我制作 WorkStep 个性化皮肤。先询问喜欢的颜色、背景、PC/手机布局和需要重点定制的控件。\n"
              f"共享 runtime 工作目录：{root}\n建议皮肤包目录：{root / 'skin'}\n本次规范文件：{root / 'skin-contract.json'}\n"
              "在 Runtime 根目录内创建或修改皮肤包，具体包目录可自行命名；默认使用上述建议目录方便右侧读取，不覆盖其他已有成果。先阅读本次规范文件和 workstep-cli 的 references/custom-skin.md。规范覆盖引擎选择框及展开选项、输入框、消息、任务、流程、Git、设置和全部浮层。"
              "只生成声明式 JSON 和本地图片，不修改 WorkStep 源码，不写脚本或任意 CSS。未覆盖部分继承默认皮肤。"
              "使用 workstep skin validate 检查，再经用户同意用 workstep skin register 注册（更新指定 --replace）；"
              "在设置→外观中预览 PC 和手机、确认应用。校验通过不等于视觉验收通过；注册后无需重启。")
    await asyncio.to_thread(prepare, root, prompt)
    return {"project_id": project.id, "project_name": project.name, "session_id": session["id"], "created": session['created'], "workspace_path": str(root), "package_path": str(root / "skin"), "prompt": prompt}
