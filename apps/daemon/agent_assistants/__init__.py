"""WorkStep agent assistant layer.

``agent_assistants/`` 只放助手模块：每个助手一个模块（文件），模块内通过
``AssistantConfig`` 注册（``base.py`` 中的 ``assistant_registry``），并复用
``AssistantRuntime`` 的会话、流式事件、停止与引擎配置基础设施。通用层位于
``base.py``（原 ``services/assistant_base.py``），新增助手 = 新增一个模块并
在 ``main.py`` 完成实例化与路由挂载（如需要）。
"""
