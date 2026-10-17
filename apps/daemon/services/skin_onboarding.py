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
    prompt = ("Help me create a personalized WorkStep skin. You can adjust colors, backgrounds, desktop/mobile layouts, font families, and four font sizes. If the user only requests a font or size change, adjust that configuration directly and preserve the rest of the appearance without asking for a new color scheme.\n"
              f"Shared Runtime workspace: {root}\nSuggested skin package directory: {root / 'skin'}\nCurrent contract file: {root / 'skin-contract.json'}\n"
              "Create or modify a skin package within the Runtime root. You may choose the package directory name; use the suggested directory by default so the right panel can read it easily. Do not overwrite other existing work. First read the current contract file and workstep-cli's references/custom-skin.md. The contract covers engine selectors and expanded options, inputs, messages, tasks, workflows, Git, settings, and all overlays. "
              "Configure font families through font-body / font-display in tokens.json (font-mono for code), with font-stack fallbacks when a font is unavailable. Configure font size through layout.fontSize in components.json: small / standard / large / extraLarge; inherit uses the device preference. Configure the send icon through layout.composerSendIcon in components.json: send (paper plane), arrow-up, or arrow-right; desktop/mobile.layout can override it separately. This only changes the send icon's appearance; the application manages stop, processing, and send events. Custom vector icons use an object {paths:[SVG path strings]}, with a fixed viewBox of 0 0 24 24 and strokes matching the button text color. For rockets or other shapes, generate paths directly in this field without changing source code or adding built-in icons. Use 1-32 paths, each at most 4096 characters, starting with M/m and coordinates. Only standard path commands, numbers, spaces, commas, decimal points, and plus/minus signs are allowed. Full SVG XML, attributes, scripts, and URLs are not accepted. When the user requests a custom icon, reread skin-contract.json and skin-design.md and follow their latest contract instead of restrictions from earlier replies. Do not modify the protected font-scale. Keep v1 packages declarative. For greater customization, use schema_version:2 with a single skin.json containing tokens/styles/layout/desktop/mobile/menus/effects, optional theme.css, optional self-contained theme.js, and local assets including WOFF2 fonts. CSS may define scoped layouts and keyframes; no @import or external resources. theme.js exports activate(api), registers independent features or supported slots, and returns cleanup. Use api.React and api.components (Button, Input, ConfirmDialog); do not bundle a second React or import application internals. api.storage(featureId) provides asynchronous browser-local get/set/delete/list/export/import; changes of version keep data. Read the v2 SDK section in references/custom-skin.md before writing code. Settings options, grouping, ordering, validation and save behavior remain application-owned; only their CSS presentation changes. Do not modify WorkStep source code or install server-side code. Layout.composerPosition supports top/bottom/left/right on desktop, compact screens stack vertically. Script revisions require explicit user enablement. Unspecified parts inherit the default skin. "
              "Check with workstep skin validate, then register with workstep skin register after user approval (use --replace for updates). "
              "Preview desktop and mobile in Settings > Appearance and confirm application. Passing validation does not mean visual acceptance. No restart is required after registration.")
    prompt += (f"\nYou can also adjust fonts alone or create an independent language package in this conversation. Suggested language package directory: {root / 'language'}; actual message catalog: {root / 'language-contract.json'}. "
               "First read messages, required_keys, and revision in the catalog. A language package contains only manifest.json, messages.json, and optionally glossary.json. The manifest must include schema_version:1, id (lowercase Latin letters, digits, hyphens, and underscores), locale (BCP47, e.g. es-ES), name, native_name, version, fallback_locale (one of zh-CN/zh-TW/en-US/ja-JP), direction:ltr, and catalog_revision (the contract revision). "
               "messages.json uses the contract's flat keys. Translations must preserve all placeholders such as {name}; translate every required_keys entry, with fallback for other missing entries. Do not override built-in languages, include HTML or JS, or modify WorkStep source code. "
               "When the user requests a language, translate the requested scope and report coverage accurately; do not count Chinese placeholders as translated. Validate with workstep language validate <directory>; after user confirmation, register with workstep language register <directory> (use --replace for updates). "
               "Use the right-side language section to read the package, inspect coverage, install, and preview it. It takes effect dynamically after the user confirms use. No restart is required. Skin and language packages are installed independently; installing a language package does not change existing fonts, layouts, or colors.")
    await asyncio.to_thread(prepare, root, prompt)
    return {"project_id": project.id, "project_name": project.name, "session_id": session["id"], "created": session['created'], "workspace_path": str(root), "package_path": str(root / "skin"), "prompt": prompt}
