# 引擎抽象层

## 设计原则

每种 LLM CLI 引擎（Claude Code / Codex / Hermes / QCode / OpenClaw / API 直调）实现同一个 `BaseLLMEngine` 接口。新增引擎 = 新增一个文件，实现接口即可接入。

## BaseLLMEngine

```python
from abc import ABC, abstractmethod
from typing import AsyncIterator

class BaseLLMEngine(ABC):
    """所有 LLM 引擎的抽象基类"""

    # ── 引擎发现 ──

    @staticmethod
    @abstractmethod
    def is_installed() -> bool:
        """检测本地是否安装了对应 CLI"""

    @staticmethod
    @abstractmethod
    def get_version() -> str | None:
        """获取已安装版本，未安装返回 None"""

    @staticmethod
    @abstractmethod
    def resolve_binary() -> str:
        """解析实际二进制路径（环境变量 → PATH → 回退名）"""

    # ── 执行 ──

    @abstractmethod
    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """启动子进程，流式 yield 统一内部事件"""

    @abstractmethod
    async def stop(self) -> None:
        """终止子进程"""

    # ── 交互 ──

    @abstractmethod
    async def inject_response(self, tool_use_id: str, content: str) -> None:
        """中途注入用户回答（AskUserQuestion / 权限请求）"""

    # ── 会话恢复 ──

    @property
    @abstractmethod
    def supports_resume(self) -> bool:
        """是否支持会话恢复"""

    @property
    @abstractmethod
    def supports_interactive(self) -> bool:
        """是否支持中途交互"""

    @abstractmethod
    def build_resume_params(self, session_id: str) -> dict:
        """构建会话恢复参数"""
```

## 统一内部事件 (InternalEvent)

所有引擎的 stdout 输出都映射为以下事件类型：

```python
from dataclasses import dataclass
from typing import Literal

@dataclass
class InternalEvent:
    type: Literal[
        "status",           # 状态变更（initializing / running）
        "text_delta",       # 助手回复增量
        "thinking_delta",   # 思考过程增量
        "tool_use",         # 工具调用（完整）
        "tool_input_delta", # 工具输入增量（仅实时，不持久化）
        "tool_result",      # 工具返回结果
        "usage",            # token 计费
        "error",            # 错误
    ]
    data: dict
    timestamp: int           # epoch ms
```

## 引擎实现

### ClaudeCodeEngine

| 属性 | 值 |
|------|---|
| 二进制 | `CLAUDE_BIN` → PATH `claude` → `openclaude` |
| 命令 | `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions` |
| stdin | JSONL 流（保持打开） |
| stdout | JSONL (Anthropic events) |
| 会话恢复 | `--resume <sessionId>` / `--session-id <uuid>` |
| 交互 | 中途注入 `tool_result`（回答 AskUserQuestion） |
| supports_resume | `True` |
| supports_interactive | `True` |

**stdout 事件映射**：

| Claude 输出 | InternalEvent |
|---|---|
| `system/init` | `status: initializing` |
| `content_block_delta` (text) | `text_delta` |
| `content_block_delta` (thinking) | `thinking_delta` |
| `content_block_delta` (input_json) | `tool_input_delta` |
| `content_block_stop` (tool_use) | `tool_use` |
| `result` | `usage` |
| `user` (含 tool_result) | `tool_result` |

### CodexEngine

| 属性 | 值 |
|------|---|
| 二进制 | PATH `codex` |
| 命令 | `codex exec --json --skip-git-repo-check --sandbox <mode> -C <cwd>` |
| stdin | 纯文本（写完关闭） |
| stdout | JSONL (thread/turn events) |
| 会话恢复 | 无 |
| 交互 | 无 |
| supports_resume | `False` |
| supports_interactive | `False` |

**沙箱策略**：
- macOS/Linux: `workspace-write`
- Windows/WSL: `danger-full-access`

**stdout 事件映射**：

| Codex 事件 | InternalEvent |
|---|---|
| `thread.started` | `status: initializing` |
| `turn.started` | `status: running` |
| `item.started` (command_execution) | `tool_use` (name: "Bash") |
| `item.completed` (command_execution) | `tool_result` |
| `item.completed` (agent_message) | `text_delta` |
| `turn.completed` | `usage` |
| `error` / `turn.failed` | `error` |

### HermesEngine

| 属性 | 值 |
|------|---|
| 二进制 | PATH `hermes` |
| 命令 | `hermes acp --accept-hooks` |
| stdin | JSON-RPC 双向 |
| stdout | JSON-RPC (session/update) |
| 会话恢复 | 无 |
| 交互 | 响应 `session/request_permission` |
| supports_resume | `False` |
| supports_interactive | `True` |

**JSON-RPC 生命周期**：
1. `initialize` → 2. `session/new` → 3. `session/set_model`（可选）→ 4. `session/prompt` → 5. 流式 `session/update` → 6. 权限请求自动批准

### 后期引擎

| 引擎 | 说明 |
|------|------|
| QCodeEngine | QCode CLI，协议待调研 |
| OpenClawEngine | OpenClaw CLI，协议待调研 |
| APIEngine | 直接调 OpenAI/Anthropic API，HTTP + SSE 流式 |

## 引擎注册表

```python
ENGINE_REGISTRY: dict[str, type[BaseLLMEngine]] = {
    "claude": ClaudeCodeEngine,
    "codex": CodexEngine,
    "hermes": HermesEngine,
    # 后续添加
}

def get_available_engines() -> list[dict]:
    """返回已安装引擎列表及其版本"""
    return [
        {"id": k, "installed": cls.is_installed(), "version": cls.get_version()}
        for k, cls in ENGINE_REGISTRY.items()
    ]
```

Daemon 启动时调用 `get_available_engines()`，前端据此显示可用/不可用引擎。
