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

1. 先读上表，找到可能的职责所有者所在领域。
2. 在 `docs/code-map/` 下搜索关键词（如模型、引擎名、功能模块名），不要只搜索索引页本身。
3. 不同引擎或模型可能各自有独立入口；关联模块 B 也可能有相关依赖，搜索目录下所有文件，避免遗漏。
4. 搜索到条目后，核对其代码路径、调用者和对应测试；跨层改动同时核对 API、schema、状态和界面。
5. 行为变更先写能复现问题的测试；移动样式核对 `mobile.css` 的共享尺寸变量和移动端检查；异步 I/O 用慢 I/O 加健康检查或轻量协程验证事件循环响应。
6. 只在职责独立、调用边界清楚时拆模块。行数与状态数量是发现问题的信号，不是拆文件目标；避免透传整组状态或让维护入口散落。
7. 更新本表和相应专题文档，运行相关测试、完整测试及构建。具体命令见 [开发指南](development.md)。
