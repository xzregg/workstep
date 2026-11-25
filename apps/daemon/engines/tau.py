"""Optional Tau harness: adapter ships with WorkStep, SDK installs on demand."""
import asyncio
from contextlib import suppress
from importlib.metadata import Distribution, PackageNotFoundError
import json
import os
from pathlib import Path
import re
import sys
from uuid import uuid4

from engines.core.acp_base import AcpEngineBase
from engines.core.packages import RuntimePackage
from services.config import CONFIG_DIR, config_store
from services.engine_packages import managed_package_version, prepare_engine_package_dir
from engines.core.base import install_python_package
from engines.core.base import EngineInstallResult, ProviderRuntimeConfig
from engines.core.events import (InternalEvent, agent_message_chunk, agent_thought_chunk,
                                tool_call_event, tool_call_update_event, usage_update_event)
from engines.core.schema import EngineConfigField, EngineConfigOption
from engines.core.permissions import EnginePermissionPolicy

SDK_VERSION = '0.4.12'
_CANCELLED = object()


def dependency_path():
    # Prefer optional managed packages. Old user installations stay usable in place.
    managed = Path(os.environ.get('WORKSTEP_ENGINE_PACKAGE_DIR') or CONFIG_DIR / 'runtime/python-packages')
    if (managed / 'tau_agent/harness.py').is_file():
        return managed
    return CONFIG_DIR / 'runtime/engines/tau/dependencies/python'


class TauEngine(AcpEngineBase):
    ENGINE_ID = 'tau'
    RUNTIME_PACKAGE = RuntimePackage('tau-ai', 'pypi')
    UPDATE_PACKAGE = 'tau-ai'
    SYSTEM_PROMPT_MODE = 'native'
    SUPPORTS_MANUAL_COMPACTION = False
    PERMISSION_POLICY = EnginePermissionPolicy(
        overrides={'auto': {'permission_mode': 'allow'}, 'ask': {'permission_mode': 'ask'}},
        consent_key='permission_mode', consent_values={'ask': None, 'allow': True, 'deny': False},
        consent_default='ask',
    )
    acp_events = frozenset({'agent_message_chunk','agent_thought_chunk','tool_call',
                            'tool_call_update','usage_update','session_started','status',
                            'error','interaction_request','live_message'})

    def __init__(self):
        super().__init__()
        self._task = None
        self._harness = None
        self._secrets = []
        self._active_session = None
        self._streamed = {}

    @staticmethod
    def get_version():
        try:
            return managed_package_version('tau-ai')
        except PackageNotFoundError:
            for dist in Distribution.discover(path=[str(dependency_path())]):
                if dist.metadata.get('Name') == 'tau-ai':
                    return dist.version
        return None

    @staticmethod
    def is_installed():
        from packaging.version import Version, InvalidVersion
        try:
            version = TauEngine.get_version()
            return bool(version and Version(version) >= Version(SDK_VERSION) and sys.version_info >= (3, 12))
        except InvalidVersion:
            return False

    @staticmethod
    def resolve_binary():
        return sys.executable if TauEngine.is_installed() else None

    @staticmethod
    def install_command():
        return 'pip install tau-ai'

    async def install(self):
        if sys.version_info < (3, 12):
            return EngineInstallResult(False, 'Tau requires Python >= 3.12')
        await self.io(prepare_engine_package_dir)
        return await install_python_package('tau-ai')

    def get_config_values(self):
        legacy = config_store.get('custom_engine_config', {}).get(self.ENGINE_ID, {})
        values = {**legacy, **config_store.get('tau_engine', {})}
        return {field.key: values.get(field.key, field.default) for field in self.config_schema()}

    async def save_config_values(self, values, clear=None, confirmed=None):
        def save():
            current = self.get_config_values()
            fields = {field.key: field for field in self.config_schema()}
            for key, value in values.items():
                if key not in fields or key == 'provider_id':
                    continue  # Provider selection is persisted by the shared configuration API.
                if key == 'permission_mode':
                    if value not in {'ask', 'allow', 'deny'}:
                        raise ValueError('Invalid permission mode')
                else:
                    number = float(value)
                    limit = 1000 if key == 'max_turns' else 86400
                    if not 0 < number <= limit or (key == 'max_turns' and not number.is_integer()):
                        raise ValueError(f'Invalid {key}')
                    value = int(number) if key == 'max_turns' else number
                current[key] = value
            for key, enabled in (clear or {}).items():
                if enabled and key in fields:
                    current[key] = fields[key].default
            config_store.set('tau_engine', current)
        await self.io(save)

    @classmethod
    def supported_provider_protocols(cls):
        return {'openai_chat_completions','openai_responses','anthropic_messages'}

    @classmethod
    def provider_required(cls):
        return True

    @classmethod
    def config_schema(cls):
        return [cls.provider_config_field(), EngineConfigField(key='permission_mode',label='工具权限',type='select',default='ask',category='mode',
                    options=(EngineConfigOption('ask','逐次审批'),EngineConfigOption('allow','允许工具'),EngineConfigOption('deny','禁用工具')),
                    help='ask 通过 WorkStep 审批后执行；deny 禁用全部工具。'),
                EngineConfigField(key='max_turns',label='最大代理轮数',type='number',default=30),
                EngineConfigField(key='request_timeout',label='单次模型请求总超时（秒）',type='number',default=900),
                EngineConfigField(key='read_timeout',label='网络无数据超时（秒）',type='number',default=300),
                EngineConfigField(key='tool_timeout',label='命令最长执行时间（秒）',type='number',default=300)]

    def is_configured(self):
        try:
            runtime = self.resolve_provider_runtime()
            return bool(runtime.model and runtime.env.get('TAU_WORKSTEP_API_KEY'))
        except (ValueError, KeyError):
            return False

    def build_provider_runtime(self, provider, model, protocol=None):
        protocol = protocol or self.pick_protocol(provider)
        base = str(provider.get('base_url') or '').rstrip('/')
        if not base:
            base = 'https://api.anthropic.com/v1' if protocol == 'anthropic_messages' else 'https://api.openai.com/v1'
        if not base.endswith('/v1') and protocol == 'anthropic_messages':
            base += '/v1'
        return ProviderRuntimeConfig(provider_id=str(provider.get('id') or ''),model=model,
                    protocol=protocol,env={'TAU_WORKSTEP_API_KEY':str(provider.get('api_key') or ''),
                                          'TAU_WORKSTEP_BASE_URL':base})

    @property
    def supports_vision(self):
        return True

    @property
    def supports_resume(self):
        return True

    @property
    def supports_interactive(self):
        return True

    @property
    def supports_tool_approval(self):
        return True

    @property
    def supports_live_step_message(self):
        return True

    def session_path(self, session_id):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', session_id):
            raise ValueError('Invalid Tau session ID')
        # Lives outside versioned packages and survives adapter updates.
        root = CONFIG_DIR / 'runtime/engines/tau-sessions'
        return root / (session_id + '.jsonl')

    async def resume_session(self, session_id, cwd, add_dirs=None, mcp_servers=None):
        if add_dirs or mcp_servers:
            return False
        def read():
            try:
                path = self.session_path(session_id)
                if not path.is_file():
                    return False
                sdk_path = str(dependency_path())
                if sdk_path not in sys.path:
                    sys.path.append(sdk_path)
                from tau_agent.session import JsonlSessionStorage, SessionState
                state = SessionState.from_entries(asyncio.run(JsonlSessionStorage(path).read_all()))
                return bool(state.session_info and state.session_info.cwd == str(Path(cwd).resolve()))
            except (ValueError, OSError):
                return False
        return await self.io(read)

    async def input_message(self, prompt, images):
        from tau_agent.messages import UserMessage, TextContent, ImageContent
        if not images:
            return UserMessage(content=prompt)
        import base64
        content = [TextContent(text=prompt)]
        for image in images:
            reference = await self.io(image.to_data_url)
            if reference.startswith(('https://', 'http://')):
                from tau_ai.http import create_async_client
                client = await self.io(lambda: create_async_client(timeout=300))
                async with client:
                    response = await client.get(reference, follow_redirects=True)
                    response.raise_for_status()
                    mime = response.headers.get('content-type', '').split(';', 1)[0]
                    data = base64.b64encode(response.content).decode('ascii')
            else:
                header, separator, data = reference.partition(',')
                if not separator or not header.startswith('data:') or not header.endswith(';base64'):
                    raise ValueError('Tau image must be a local image, HTTP URL or base64 data URL')
                mime = header[5:].split(';', 1)[0]
                base64.b64decode(data, validate=True)
            if mime not in {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}:
                raise ValueError('Tau image format must be PNG, JPEG, GIF or WebP')
            content.append(ImageContent(data=data, mime_type=mime))
        return UserMessage(content=content)

    @staticmethod
    def load_sdk():
        from engines._tau_runtime import CheckedProvider, guard_response
        from tau_ai.http import create_async_client
        from tau_agent.harness import AgentHarness, AgentHarnessConfig
        from tau_agent.session import JsonlSessionStorage, SessionState, SessionInfoEntry, MessageEntry
        from tau_coding.tools import create_coding_tools
        from tau_ai.env import OpenAICompatibleConfig, AnthropicConfig
        from tau_ai.openai_compatible import OpenAICompatibleProvider
        from tau_ai.anthropic import AnthropicProvider
        return (CheckedProvider, guard_response, create_async_client, AgentHarness, AgentHarnessConfig,
                JsonlSessionStorage, SessionState, SessionInfoEntry, MessageEntry, create_coding_tools,
                OpenAICompatibleConfig, AnthropicConfig, OpenAICompatibleProvider, AnthropicProvider)

    @staticmethod
    async def io(function):
        work = asyncio.create_task(asyncio.to_thread(function))
        try:
            return await asyncio.shield(work)
        except asyncio.CancelledError:
            # Finish our disk write before reporting cancellation or closing the worker.
            with suppress(Exception):
                await work
            raise

    @staticmethod
    async def read_state(storage, state_class):
        # Tau 0.4.12 async storage methods perform synchronous fsync/locking.
        def read():
            return state_class.from_entries(asyncio.run(storage.read_all()))
        return await TauEngine.io(read)

    @staticmethod
    async def append_entry(storage, entry):
        await TauEngine.io(lambda: asyncio.run(storage.append(entry)))

    def _finish_content(self, message):
        content = message.get('content') or []
        if isinstance(content, str):
            content = [{'type': 'text', 'text': content}]
        events = []
        for index, block in enumerate(content):
            kind = block.get('type')
            if kind not in {'text', 'thinking'}:
                continue
            text = block.get('text' if kind == 'text' else 'thinking', '')
            sent = self._streamed.get((kind, index), '')
            if not text.startswith(sent):
                raise RuntimeError('Tau final content differs from streamed content')
            suffix = text[len(sent):]
            if suffix:
                events.append(agent_message_chunk(suffix) if kind == 'text' else agent_thought_chunk(suffix))
        self._streamed.clear()
        return events

    def clean(self, value):
        text = json.dumps(value, ensure_ascii=False)
        for secret in self._secrets:
            if secret:
                text = text.replace(json.dumps(secret, ensure_ascii=False)[1:-1], '[REDACTED]')
        return json.loads(text)

    def map_event(self, raw):
        raw = self.clean(raw)
        kind = raw.get('type')
        if kind == 'message_start' and (raw.get('message') or {}).get('role') == 'assistant':
            self._streamed.clear()
        if kind == 'message_update':
            stream = raw.get('assistantMessageEvent') or raw.get('assistant_message_event') or {}
            event_type = stream.get('type')
            if event_type in {'text_delta', 'thinking_delta'}:
                channel = 'text' if event_type == 'text_delta' else 'thinking'
                key = (channel, stream.get('content_index', stream.get('contentIndex', 0)))
                delta = stream.get('delta', '')
                self._streamed[key] = self._streamed.get(key, '') + delta
                return [agent_message_chunk(delta) if channel == 'text' else agent_thought_chunk(delta)]
        if kind in {'tool_execution_start','tool_execution_update','tool_execution_end'}:
            call_id = raw.get('toolCallId') or raw.get('tool_call_id')
            name = raw.get('toolName') or raw.get('tool_name') or 'tool'
            if not call_id:
                raise ValueError('Tau tool event missing tool call ID')
            if kind == 'tool_execution_start':
                return [tool_call_event(call_id,name,raw_input=raw.get('args',{})),
                        tool_call_update_event(call_id,'in_progress')]
            if kind == 'tool_execution_update':
                return [tool_call_update_event(call_id,'in_progress',raw_output=raw.get('partialResult',raw.get('partial_result')))]
            return [tool_call_update_event(call_id,'failed' if raw.get('isError',raw.get('is_error')) else 'completed',raw_output=raw.get('result'))]
        if kind == 'message_end':
            message = raw.get('message') or {}
            if message.get('role') != 'assistant':
                return []
            if message.get('stopReason',message.get('stop_reason')) in {'error','aborted'}:
                return [InternalEvent(type='error',data={'message':message.get('errorMessage') or message.get('error_message') or 'Tau execution aborted'})]
            events = self._finish_content(message)
            if message.get('stopReason', message.get('stop_reason')) == 'length':
                events.append(InternalEvent(type='error', data={'message': 'Tau output truncated by a token limit'}))
            usage = message.get('usage') or {}
            if any(isinstance(usage.get(k),int) and usage[k] > 0 for k in ('input','output','totalTokens','total_tokens','cacheRead','cacheWrite')):
                data = {'input_tokens':max(0,usage.get('input',0)), 'output_tokens':max(0,usage.get('output',0)),
                        'total_tokens':max(0,usage.get('totalTokens',usage.get('total_tokens',0))),
                        'cache_read_tokens':max(0,usage.get('cacheRead',usage.get('cache_read',0))),
                        'cache_write_tokens':max(0,usage.get('cacheWrite',usage.get('cache_write',0)))}
                events.append(usage_update_event(data))
            return events
        return []

    async def spawn(self, prompt, cwd, model=None, session_id=None, images=None,
                    config_overrides=None, **kwargs):
        if self._task and not self._task.done():
            raise RuntimeError('Tau already running')
        if kwargs.get('schema') or kwargs.get('goal_action'):
            yield InternalEvent(type='error',data={'message':'Unsupported Tau capability requested'})
            return
        queue = asyncio.Queue()
        async def execute():
            provider = None
            client = None
            try:
                # Load optional SDKs only when the user executes an installed engine.
                path = str(await self.io(dependency_path))
                if path not in sys.path:
                    sys.path.append(path)
                (CheckedProvider, guard_response, create_async_client, AgentHarness, AgentHarnessConfig,
                 JsonlSessionStorage, SessionState, SessionInfoEntry, MessageEntry, create_coding_tools,
                 OpenAICompatibleConfig, AnthropicConfig, OpenAICompatibleProvider, AnthropicProvider) = await self.io(self.load_sdk)
                overrides = config_overrides or {}
                runtime = await self.io(lambda: self.resolve_provider_runtime(provider_id=overrides.get('provider_id'),model=model))
                api_key = runtime.env.get('TAU_WORKSTEP_API_KEY','')
                self._secrets = [api_key] if api_key else []
                if not runtime.model or not api_key:
                    raise ValueError('请在设置中选择供应商和默认模型，并保存供应商密钥')
                values = {**await self.io(self.get_config_values), **overrides}
                def seconds(key, default):
                    value = float(values.get(key, default))
                    if not 0 < value <= 86400:
                        raise ValueError(f'{key} must be between 0 and 86400 seconds')
                    return value
                request_timeout = seconds('request_timeout', 900)
                read_timeout = seconds('read_timeout', 300)
                tool_timeout = seconds('tool_timeout', 300)
                client = await self.io(lambda: create_async_client(timeout=read_timeout, event_hooks={'response': [guard_response]}))
                options = dict(api_key=api_key,base_url=runtime.env['TAU_WORKSTEP_BASE_URL'],max_retries=1,
                               timeout_seconds=read_timeout, supports_images=True)
                if runtime.protocol == 'anthropic_messages':
                    provider = AnthropicProvider(AnthropicConfig(**options), client=client)
                else:
                    provider = OpenAICompatibleProvider(OpenAICompatibleConfig(**options,
                         api='openai-responses' if runtime.protocol == 'openai_responses' else 'openai-completions',
                         infer_api_from_model=False), client=client)
                resolved_cwd = await self.io(lambda: str(Path(cwd).resolve()))
                sid = session_id or uuid4().hex
                storage_path = self.session_path(sid)
                if session_id and not await asyncio.to_thread(storage_path.is_file):
                    raise ValueError('Tau session does not exist')
                storage = JsonlSessionStorage(storage_path)
                state = await self.read_state(storage, SessionState)
                has_session = state.session_info is not None
                if not has_session:
                    first = SessionInfoEntry(cwd=resolved_cwd)
                    await self.append_entry(storage, first)
                    await asyncio.to_thread(os.chmod, storage_path, 0o600)
                    state = SessionState.from_entries([first])
                if state.session_info and state.session_info.cwd != resolved_cwd:
                    raise ValueError('Tau session belongs to a different working directory')
                parent = state.active_leaf_id
                self._active_session = sid
                await queue.put(InternalEvent(type='session_started',data={'session_id':sid}))
                permission = values.get('permission_mode', 'ask')
                self.configure_interaction_policy(values)
                if permission not in {'ask','allow','deny'}:
                    raise ValueError('Invalid permission mode')
                tools_disabled = kwargs.get('_disable_tools') or kwargs.get('disable_tools') or permission == 'deny'
                tools = [] if tools_disabled else await self.io(lambda: create_coding_tools(cwd=cwd))
                async def before_tool(call):
                    if call.name == 'bash':
                        call.arguments['timeout'] = min(float(call.arguments.get('timeout', tool_timeout)), tool_timeout)
                    if permission == 'allow':
                        return False,None
                    approved, _ = await self.handle_tool_permission(queue.put,tool_name=call.name,
                                      tool_input=call.arguments,tool_use_id=call.id,session_id=sid)
                    return not approved, None if approved else 'Tool execution denied by WorkStep'
                max_turns = int(values.get('max_turns', 30))
                if not 1 <= max_turns <= 1000:
                    raise ValueError('max_turns must be between 1 and 1000')
                self._harness = AgentHarness(AgentHarnessConfig(provider=CheckedProvider(provider, request_timeout),model=runtime.model,
                          system=kwargs.get('system_prompt') or 'You are a coding agent. Use the available tools to complete the user request. Report failures accurately.',
                          tools=tools,max_turns=max_turns,session_id=sid,before_tool_call=before_tool),messages=state.messages)
                async def persist(event):
                    nonlocal parent
                    if event.type == 'message_end':
                        entry = MessageEntry(parent_id=parent,message=event.message)
                        await self.append_entry(storage, entry)
                        parent = entry.id
                self._harness.subscribe(persist)
                await queue.put(InternalEvent(type='status',data={'status':'running'}))
                self._streamed.clear()
                failed = False
                ended = False
                message = await self.input_message(prompt, images)
                async for native in self._harness.prompt_message(message):
                    ended |= native.type == 'agent_end'
                    for event in self.map_event(native.model_dump(mode='json',by_alias=True)):
                        failed |= event.type == 'error'
                        await queue.put(event)
                if not ended and not failed:
                    raise RuntimeError('Tau agent stream ended before completion')
                if not failed:
                    await queue.put(InternalEvent(type='status',data={'status':'done'}))
            except asyncio.CancelledError:
                await queue.put(InternalEvent(type='status',data={'status':'cancelled'}))
                await queue.put(_CANCELLED)
                raise
            except Exception as exc:
                await queue.put(InternalEvent(type='error',data={'message':self.clean(str(exc))}))
            finally:
                self._harness = None
                self._active_session = None
                if provider:
                    with suppress(Exception):
                        await provider.aclose()
                if client:
                    with suppress(Exception):
                        await client.aclose()
                await queue.put(None)
        self._task = asyncio.create_task(execute())
        live_task = None
        live_queue = kwargs.get('live_message_queue')
        if live_queue is not None:
            async def forward_live():
                while True:
                    item = await live_queue.get()
                    content = item if isinstance(item,str) else item.get('content',item.get('message',''))
                    # Wait for harness creation, without losing the queued message.
                    while (self._harness is None or not self._harness.is_running) and not self._task.done():
                        await asyncio.sleep(.01)
                    if await self.send_live_step_message(content):
                        await queue.put(InternalEvent(type='live_message',data={'content':content,'status':'delivered'}))
            live_task = asyncio.create_task(forward_live())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                if event is _CANCELLED:
                    raise asyncio.CancelledError
                yield event
        finally:
            if live_task:
                live_task.cancel()
                with suppress(asyncio.CancelledError):
                    await live_task
            await self.stop()

    async def spawn_coordinator(self,prompt,cwd,model=None,session_id=None,images=None,config_overrides=None,**kwargs):
        kwargs['_disable_tools'] = True
        async for event in self.spawn(prompt,cwd,model,session_id,images,config_overrides,**kwargs):
            yield event

    async def send_live_step_message(self, content):
        if not self._harness or not self._harness.is_running:
            return False
        self._harness.steer(str(content))
        return True

    async def stop(self):
        if self._harness:
            self._harness.cancel()
        task = self._task
        if task and not task.done() and task is not asyncio.current_task():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
