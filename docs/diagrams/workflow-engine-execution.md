# 工作流引擎执行全景图

本页汇总任务生命周期、单阶段执行与产物路由，以及阶段消息和局部重跑。更完整的规则说明见[工作流引擎执行全景](../workflow-engine-execution.md)。

端口级分流和多输入等待另见 [A1/A2 与 B/C 依赖示例](artifact-port-fanout.svg)。

## 任务运行生命周期

![任务从预备、排队进入运行，并经过审核、重试、暂停和恢复](workflow-task-lifecycle.svg)

## 单阶段执行与产物路由

![阶段解析输入快照、运行引擎、经过审核并按非空产物端口路由](workflow-stage-execution.svg)

## 阶段消息、协调助手与局部重跑

![运行中消息复用会话，协调助手确认后创建目标阶段及下游的局部重跑](workflow-manual-control.svg)

需要浏览器大图布局时，可打开 [HTML 版本](workflow-engine-execution.html)。
