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
from services.languages import read_contract as language_contract
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
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=root, prefix='.language-contract-', delete=False) as file:
            temporary = Path(file.name)
            file.write(json.dumps(language_contract(), ensure_ascii=False, indent=2))
        temporary.replace(root / 'language-contract.json')
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
    prompt = ("请帮我制作 WorkStep 个性化皮肤。可调整颜色、背景、PC/手机布局、字体类型和四档字号；用户只要求字体或字号时直接调整对应配置，保留其他外观，不要求重新选择配色。\n"
              f"共享 runtime 工作目录：{root}\n建议皮肤包目录：{root / 'skin'}\n本次规范文件：{root / 'skin-contract.json'}\n"
              "在 Runtime 根目录内创建或修改皮肤包，具体包目录可自行命名；默认使用上述建议目录方便右侧读取，不覆盖其他已有成果。先阅读本次规范文件和 workstep-cli 的 references/custom-skin.md。规范覆盖引擎选择框及展开选项、输入框、消息、任务、流程、Git、设置和全部浮层。"
              "字体类型使用 tokens.json 的 font-body / font-display（代码字体用 font-mono），系统没有该字体时通过字体栈回退；字号使用 components.json 的 layout.fontSize：small / standard / large / extraLarge，inherit 表示沿用设备字号。发送图标通过 components.json 的 layout.composerSendIcon 配置：send（纸飞机）、arrow-up（向上箭头）、arrow-right（向右箭头），desktop/mobile.layout 可分别覆盖。只改变发送外观，停止、处理中和发送事件由应用管理，不可用任意 SVG、脚本或 URL 替换。禁止修改受保护的 font-scale。只生成声明式 JSON 和本地图片，不修改 WorkStep 源码，不写脚本或任意 CSS。未覆盖部分继承默认皮肤。"
              "使用 workstep skin validate 检查，再经用户同意用 workstep skin register 注册（更新指定 --replace）；"
              "在设置→外观中预览 PC 和手机、确认应用。校验通过不等于视觉验收通过；注册后无需重启。")
    prompt += (f"\n也可以只调整字体或制作独立语言包，继续沿用本对话。语言包建议目录：{root / 'language'}；真实文案目录：{root / 'language-contract.json'}。"
               "先读取该目录中的 messages、required_keys 和 revision；语言包只包含 manifest.json、messages.json，可选 glossary.json。manifest 必须有 schema_version:1、id（小写英文数字及横杠下划线）、locale（BCP47，如 es-ES）、name、native_name、version、fallback_locale（zh-CN/zh-TW/en-US/ja-JP 之一）、direction:ltr、catalog_revision（规范 revision）。"
               "messages.json 使用规范的扁平键，翻译必须保留所有 {name} 等占位符；required_keys 必须全部翻译，其他缺失项回退；不允许覆盖内置语言、HTML、JS 或改 WorkStep 源码。"
               "用户要求增加语言时翻译其指定范围并如实说明覆盖率，不把中文占位当已翻译。执行 workstep language validate <目录> 校验；用户确认后 workstep language register <目录>（更新 --replace）。"
               "在右侧语言分区读取、查看覆盖率、安装并预览，用户确认使用后动态生效，无需重启。皮肤和语言包独立安装，不改变现有字体、布局或配色。")
    await asyncio.to_thread(prepare, root, prompt)
    return {"project_id": project.id, "project_name": project.name, "session_id": session["id"], "created": session['created'], "workspace_path": str(root), "package_path": str(root / "skin"), "prompt": prompt}
