"""Explicit delegation selection, called within the project database executor."""
from engines.core.registry import create_engine
from services.config import config_store


def _validate_selection(chats, project_id, engine, model, current=None, *, require_verified=True):
    for name, value in (('engine', engine), ('model', model)):
        if value is not None and (not isinstance(value, str) or not value.strip() or value != value.strip()):
            raise ValueError(f'Delegation {name} must be a nonempty ID without surrounding whitespace')
    engine_id = engine or (current['engine'] if current else chats._resolve_project_engine_models(project_id)[0])
    adapter = create_engine(engine_id)
    if adapter is None:
        raise ValueError(f'Engine {engine_id} is unavailable. Use engine list --json; install/configure it in Settings.')
    chats._validate_engine(engine_id)
    if engine is not None and (not current or engine != current['engine']) and not config_store.is_engine_enabled(engine_id):
        raise ValueError(f'Engine {engine_id} is hidden. Enable it in Settings → Execution engines before selecting it.')
    provider_id = (current.get('provider_id') or '') if current and current['engine'] == engine_id else ''
    if current is None:
        name = chats._execution_settings_name(project_id)
        defaults = config_store.get_assistant_defaults(name)
        if engine_id == (defaults.get('engine') or engine_id):
            provider_id = config_store.get_assistant_config(name).get('provider_id', '')
    resolver = getattr(adapter, 'resolve_provider_catalog', None)
    catalog = resolver(provider_id=provider_id) if callable(resolver) else None
    # A valid session provider can configure an engine whose host default is unset.
    if not catalog and not adapter.is_configured():
        raise ValueError(f'Engine {engine_id} is not configured. Configure it in Settings → Execution engines.')
    if model is not None:
        if catalog:
            from services.providers import saved_models
            models = {item.id for item in saved_models(*catalog)}
        else:
            models = {item['id'] for item in (config_store.get_engine_models(engine_id) or {}).get('models', [])}
        if model not in models:
            raise ValueError(f'Model {model} is not in the selected engine/provider catalog. '
                             f'Use engine models --engine {engine_id} --project {project_id} --refresh --json '
                             '(include the session provider if set), or update saved provider models in Settings.')
    if model is None:
        if current and current['engine'] == engine_id:
            model = current.get('model') or config_store.get_engine_default_model(engine_id)
        else:
            default_engine, default_model, _ = chats._resolve_project_engine_models(project_id)
            model = ((default_model if engine_id == default_engine else None)
                     or config_store.get_engine_default_model(engine_id))
    if not model:
        raise ValueError('无法确定实际模型。请显式指定经验证的 model，不能以不确定的默认模型接受显式选择。')
    if require_verified:
        from services.delegation_capabilities import is_verified
        project = chats._project_manager.get_project_by_id(project_id)
        if not is_verified(project, adapter, model, provider_id):
            raise ValueError('该项目的引擎／模型组合未经创建与跟进验证。使用 digital-hub delegate-verify 测试后再选择。')
    return {'engine': engine_id, 'model': model, 'provider_id': provider_id}


def validate_selection(chats, project_id, engine, model, current=None, *, require_verified=True):
    try:
        return _validate_selection(chats, project_id, engine, model, current, require_verified=require_verified)
    except ValueError as exc:
        from services.delegation_capabilities import options
        project = chats._project_manager.get_project_by_id(project_id)
        available = options(project, current_engine=current['engine'] if current else '',
                            current_provider_id=(current.get('provider_id') or '') if current else '')
        choices = ', '.join(f"{row['engine']} / {row['model']}" for row in available) or '暂无已验证组合'
        raise ValueError(f'暂不支持：{exc}。已验证可选项：{choices}。使用 digital-hub delegate-options --project {project_id} --json 查询。') from exc


def apply_selection(chats, project_id, session_id, engine, model):
    current = chats.get_execution_config(project_id, session_id)
    selected = validate_selection(chats, project_id, engine, model, current)
    if selected['engine'] != current['engine']:
        chats.handoff_session(project_id, session_id, engine=selected['engine'], context_mode='smart',
                              model=selected['model'], fast_model=selected['model'], provider_id=selected['provider_id'])
    # Pin even an inherited/default model: an accepted explicit selection cannot
    # resolve to a different host default when the worker starts later.
    return chats.update_execution_config(project_id, session_id, {'model': selected['model']})
