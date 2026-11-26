# Code Map Index

- [Digital Person](code-map/digital-person.md)
- [Memory / Thinking](code-map/memory.md)
- [Engines & Models](code-map/engines.md)
- [Chat & Messaging](code-map/chat.md)
- [Tasks & Workflow](code-map/tasks.md)
- [UI & Rendering](code-map/ui.md)
- [Gateway & Admin](code-map/gateway.md)
- [Desktop & Packaging](code-map/desktop.md)
- [CLI & Skills](code-map/cli.md)
- [Other](code-map/other.md)

_Each sub-file contains the relevant code-map entries for that domain._

## 使用方法

1. 用上表找到职责所有者，搜索其调用者和对应测试；跨层改动同时核对 API、schema、状态和界面。
2. 行为变更先写能复现问题的测试；移动样式核对 `mobile.css` 的共享尺寸变量和移动端检查；异步 I/O 用慢 I/O 加健康检查或轻量协程验证事件循环响应。
3. 只在职责独立、调用边界清楚时拆模块。行数与状态数量是发现问题的信号，不是拆文件目标；避免透传整组状态或让维护入口散落。
4. 更新本表和相应专题文档，运行相关测试、完整测试及构建。具体命令见 [开发指南](development.md)。
