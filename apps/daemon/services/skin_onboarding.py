"""Create a skin design workspace using ordinary project chat."""
import asyncio
import json
import uuid
from pathlib import Path

from services.project import project_manager
from services.skill_center import skill_center
from services.skins import read_contract


def chat_module():
    from services.custom_engine_onboarding import chat_module as resolve
    return resolve()


def workspace_parent():
    from services.config import CONFIG_DIR
    from services.project_scope import projects_root
    root = projects_root()
    return root / "workstep-skin-workspaces" if root else CONFIG_DIR / "runtime" / "skin-workspaces"


def prepare(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / "skin-contract.json").write_text(json.dumps(read_contract(), ensure_ascii=False, indent=2), encoding="utf-8")
    package = root / "skin"
    package.mkdir()
    (package / "skin.json").write_text(json.dumps({"id": "my-skin-" + root.name[:6], "name": "我的皮肤", "version": "1.0.0", "schema_version": 1, "color_scheme": "light"}, ensure_ascii=False, indent=2), encoding="utf-8")
    for name in ("tokens.json", "components.json"):
        (package / name).write_text("{}\n", encoding="utf-8")


async def create_onboarding():
    module = chat_module()
    await asyncio.to_thread(module._resolve_engine_models)
    root = await asyncio.to_thread(lambda: workspace_parent() / uuid.uuid4().hex[:12])
    await asyncio.to_thread(prepare, root)
    project = await asyncio.to_thread(project_manager.init_project, root, name="皮肤设计" + root.name[:6])
    await asyncio.to_thread(skill_center.runtime_selection, root)
    session = await project_manager.run_db(project.id, lambda current: module.create_session(project.id, title="自定义皮肤设计"))
    prompt = ("请帮我制作 WorkStep 个性化皮肤。先询问喜欢的颜色、背景、PC/手机布局和需要重点定制的控件。\n"
              f"工作目录：{root}\n皮肤包目录：{root / 'skin'}\n"
              "先阅读工作目录 skin-contract.json 和 workstep-cli 的 references/custom-skin.md。规范覆盖引擎选择框及展开选项、输入框、消息、任务、流程、Git、设置和全部浮层。"
              "只生成声明式 JSON 和本地图片，不修改 WorkStep 源码，不写脚本或任意 CSS。未覆盖部分继承默认皮肤。"
              "使用 workstep skin validate 检查，再经用户同意用 workstep skin register 注册（更新指定 --replace）；"
              "在设置→外观与皮肤中预览 PC 和手机、确认应用。校验通过不等于视觉验收通过；注册后无需重启。")
    return {"project_id": project.id, "project_name": project.name, "session_id": session["id"], "workspace_path": str(root), "package_path": str(root / "skin"), "prompt": prompt}
