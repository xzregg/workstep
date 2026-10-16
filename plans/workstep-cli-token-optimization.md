# WorkStep CLI token 优化

## 方案与边界

- 主技能仅保留调用约束、安全规则与专题索引；详细操作拆到同目录 references，按需读取。
- 所有 list 支持可选 --limit/--offset，list/get 支持 --fields；保持原默认返回范围。
- task list 支持 --archived（复用现有 API）、--status/--workflow（本地筛选）。
- JSON 使用紧凑分隔符；错误响应完整保留。先筛选，再裁剪，再选择字段。
- 本地分页输出 total/offset/remaining；数组型响应仅在显式分页时包装为 items 对象。
- 不修改 REST API，不减少 daemon 查询和传输量，不手改生成技能镜像。

## 验证结果

2026-10-16，使用 cl100k_base 分词器，模拟数据不含真实项目内容。

| 场景 | 优化前 tokens | 优化后 tokens | 减少 |
| --- | ---: | ---: | ---: |
| 技能主文件 | 6,719 | 882 | 86.9% |
| 任务列表，100 条摘要 → 前 20 条 ID/标题/状态 | 7,404 | 396 | 94.7% |
| 单任务详情 → ID/标题/状态 | 479 | 20 | 95.8% |

技能基线取实施前工作区版本（包含既有未提交修改）。输出基线使用原 --json 分隔符；优化结果使用紧凑分隔符。
列表和详情收益依赖显式字段选择和条数限制，不代表所有请求都有相同降幅。
按需读取专题会增加该次任务实际上下文；882 tokens 仅指主文件。

模拟数据：100 条任务，id=task-000 至 task-099，title=演示任务 N，status=running，
archived=false，workflow_id=demo，created_at=2026-10-16T09:00:00，
updated_at=2026-10-16T09:10:00，description 为“详细说明”重复 100 次。
详情使用第一条任务。列表基线保留原摘要字段；优化选择 id,title,status 并 limit=20。

验收命令：

```bash
uv run --no-sync --directory apps/daemon pytest tests/test_cli.py tests/test_builtin_workstep_cli_skill.py tests/test_engine_project_skills.py tests/test_skill_center.py -q
```

结果：100 passed。另已核对所有技能 Markdown 本地链接、主文件预算和 git diff --check。
