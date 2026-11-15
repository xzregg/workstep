# 记忆检索评测

仓库根目录执行，无需启动服务。评测进程本身不调用模型；当前关键词搜索只查提炼后的知识，检索准确率必须提供模型提炼产物：

```sh
uv run --no-sync --directory apps/daemon python -m memory_evaluation --memories-file /path/to/extraction.json
```

输出 `tmp/memory-eval/<时间>/report.md` 和 `report.json`。支持 `--memories-file <提炼结果JSON>`、`--query-plan <问题ID到关键词的JSON>`、`--diagnostic-valid-only`、`--dataset <JSON文件>`、`--output <尚不存在的目录>`、`--top-k 1,3,5`、`--repeats 10`。退出码 1 表示执行异常；低召回率保留为结果，不冒充工程异常。

独立进程设置临时配置与项目目录，为人工用户资料补充无信息的完成回复，通过真实项目 SQLite、完成回复登记、`assessment.commit`、`memory_query.search/history` 和 CLI `compact` 评测。合成确认回复不属于标准证据，不参与证据评分。关闭后删除临时数据库，保留报告，不访问现有用户记忆。不要嵌入已经加载服务配置的进程。

## 数据与指标

默认数据集是 18 条人工中文消息、19 道诊断题，包括事实、多会话证据、偏好、改口、计划与结果、改写查询、无答案、项目隔离、遗忘和按月分页回顾。不是公开基准复现，也不代表真实用户分布。

自定义 JSON 沿用样例：`sources` 包含唯一 `id`、`project`、`session`、带时区 `time`、`role`、`text`；`cases` 包含唯一 `id`、`category`、`query`、`expected_ids`，可选 `projects`、`forget_ids`、`operation: history`、`since/before`。`answer` 只是预留参考，不参与当前评分。遗忘案例最后运行，多个遗忘案例累积生效，需要独立场景时拆分数据集。

- Hit@K：至少找到一条标准证据。
- Recall@K：找到标准证据的比例。
- Precision@K：返回证据中正确的比例，分母为实际返回的去重源消息数。
- 全证据命中：必要证据是否全部找到。
- MRR@K：第一条正确证据排名的倒数。
- 无答案单独记录错误返回，不当成完美召回，也不代表最终拒答质量。
- history 全量分页后评估覆盖，不纳入 search 宏平均。
- 首次、P50/P95 延迟及完整／精简 JSON 的 UTF-8 字节数。字节数不是 token 数。

K按知识条目排名计数，收集前K条知识引用的全部标准源消息并去重，再计算证据准确率、召回率；同一知识点的多条必要证据都参与评分。异常保留在有答案问题的统计分母中；无答案异常看 `error`，不能当作通过。默认 3 次重复，P95 不能用于容量规划；耗时含进程缓存效应。时间及衰减仍随运行日期变化，报告记录数据哈希、代码版本、工作区脏状态及执行时间。

## 边界

模型提炼由外部生成产物提供，`extraction_metadata`记录供应商、模型及生成耗时；模型只能看到原始资料，不能看到题目和标准答案。关键词改写模型只能看到问题，不能看到资料或答案。未提供提炼产物时不能用关键词分数判断当前记忆系统。仍不测最终回答正确率、拒答、任务 eventlogs、真实规模并发和 I/O 次数。改口题只检查新证据是否找回，不代表冲突消解；时间范围由数据集指定，不测模型对“上月”的理解。

建议将真实失败问题脱敏加入固定集，使用相同 K、重复次数和数据哈希对比代码改动。最终回答质量需要固定回答模型及独立评分器，对比无记忆、全文历史和检索记忆，另外记录模型、成本和人工抽检；不能直接使用检索命中率代替回答准确率。

方法参考：[LongMemEval](https://github.com/xiaowu0162/LongMemEval)、[LoCoMo](https://github.com/snap-research/LoCoMo)、[Mem0 Memory Benchmarks](https://github.com/mem0ai/memory-benchmarks)。借鉴证据标注、问题分类和检索／回答分层，不引用其分数作为本项目成绩。
# CLI 搜索链路验证

`uv run --no-sync --directory apps/daemon pytest tests/test_memory_search_pipeline.py -q`
使用隔离项目中的完整对话，通过当前主动思考 pending CLI、结构化结果提交、search CLI 和 read CLI 验证：默认摘要、人名、地点、别名、关系文字、经验操作、无答案、跨会话关联及原文展开。模型输出使用固定测试数据，因此证明程序链路可用，不代表真实模型提炼质量。报告写入 `tmp/memory-search-e2e/pipeline.json`。

真实模型调用失败应单独记为失败，不能用固定输出替代后宣称质量验收通过。实库只读搜索可以验证既有生成记忆的可检索性；检索命中不等于精确关系推理，宽词召回需评估干扰结果。时间型调查采用“先回顾时间范围的消息→概括事件→从事实推导关联词→搜索知识和经验→核对原文”，跨时间经验与本期事件分别报告。

真实模型评测应显式记录供应商、模型、协议、推理／输出预算和超时；默认 Pydantic AI 配置不代表数字人实际使用的引擎或用户指定的供应商。模型返回JSON后还必须通过 `assessment.commit` 的真实校验和搜索验证。经验的 outcome 仅接受 reported/observed/failed，关系端点引用同一知识点 entities[].name 的规范名称，别名存放在 aliases。相关提示词契约回归见 `test_companion_contact_context.py`。


## 提炼格式失败与诊断分开

`--memories-file`格式为 `{"memories":[...]}`，source_ids中的memory:N表示数据集第N条原资料，脚本映射为隔离库实际ID。正常模式保留生产整批原子提交：一条候选非法则整批失败，写出失败报告，搜索题异常保留在分母，退出码1。

`--diagnostic-valid-only`只在隔离评测中跳过非法知识，保留全部题目和标准证据，单独测合法知识的检索能力。报告标记诊断模式及被拒候选，不能将该分数当作生产端到端成功率。无答案、权限隔离和遗忘需要分别看错误与返回记录；空库导致的空结果不算有效验证。

对比原问题与联想关键词时，使用同一个数据集和同一个提炼产物，保持K和重复次数相同。query-plan只做一次静态改写，不代表已经验证LLM按搜索反馈自适应多轮检索。


## 知识维护回归

`uv run --no-sync --directory apps/daemon pytest tests/test_memory_maintenance.py tests/test_digital_person_unified.py -q`

覆盖模型非法关系端点反馈修正、连续失败不入库／不完成、搜索摘要不能授权替代、分页完整读取与版本绑定、旧知识并发变化拒绝覆盖、后台禁止旧原文／时间回顾及慢读取事件循环 canary。替代及变更审计在知识事务内；关系结算和渠道通知在成功提交之后。语义正确性仍由真实模型固定数据评测与人工抽检验证，结构校验不能证明模型没有幻觉。

参考 OpenViking 的分类提炼、先读取再修改和有限错误反馈机制，保留现有 SQLite、CLI 和五维检索，不新增嵌入模型或独立后台调度。全局实体消歧、主题目录及自动语义合并尚未实现，不能据此声称已达到 OpenViking 的完整能力。
