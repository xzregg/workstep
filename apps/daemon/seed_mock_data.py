"""Add rich mock data for ALL tasks, each with full stage chain messages."""
import sys, json, time, uuid
sys.path.insert(0, '.')
from services.project import project_manager
from models import Task, TaskStep, Message

project_manager.register('/Users/xzr/Desktop/test_workstep')
project_manager.bind_project('/Users/xzr/Desktop/test_workstep')

# Read actual step keys from steps.json
proj = project_manager.get_project('/Users/xzr/Desktop/test_workstep')
steps_data = proj.steps
if steps_data.get('nodes'):
    step_keys = [n.get('type') for n in steps_data['nodes']]
    step_labels = {n.get('type'): n.get('title') for n in steps_data['nodes']}
else:
    step_keys = [s.get('key') for s in steps_data.get('steps', [])]
    step_labels = {s.get('key'): s.get('label') for s in steps_data.get('steps', [])}

print(f"Step keys: {step_keys}")
print(f"Step labels: {step_labels}")

now = int(time.time())
tasks = list(Task.select().order_by(Task.created_at))
print(f"Total tasks: {len(tasks)}")

# Template messages for each stage (will be customized per task)
def get_stage_messages(task_title, sk, sk_idx, total_stages):
    sk_label = step_labels.get(sk, sk)
    next_sk = step_keys[sk_idx + 1] if sk_idx < total_stages - 1 else None

    templates = {
        'req': [
            ('user', f'开始分析「{task_title}」的需求'),
            ('assistant', f'好的，我来分析「{task_title}」的需求。\n\n让我先了解项目背景和用户场景...'),
            ('assistant', f'## {task_title} — 需求分析\n\n### 背景\n当前存在的问题和用户痛点...\n\n### 核心需求\n1. 功能需求：主要功能点\n2. 体验需求：用户体验优化\n3. 性能需求：性能指标\n\n### 优先级\n| 需求 | 优先级 | 预计工时 |\n|------|--------|----------|\n| 核心功能 | P0 | 3天 |\n| 体验优化 | P1 | 2天 |\n| 性能优化 | P2 | 1天 |\n\n### 验收标准\n- [ ] 功能完整可用\n- [ ] 用户体验流畅\n- [ ] 性能达标'),
            ('user', '需求分析OK，输出PRD文档'),
            ('assistant', f'收到，PRD文档已完成。\n\n# {task_title} PRD\n\n## 概述\n{task_title}的详细产品需求文档...\n\n## 功能列表\n1. 功能A：描述\n2. 功能B：描述\n3. 功能C：描述\n\n## 排期\n| 阶段 | 工时 |\n|------|------|\n| 设计 | 2天 |\n| 开发 | 5天 |\n| 测试 | 2天 |'),
        ],
        'ui': [
            ('user', f'PRD确认，开始「{task_title}」的UI设计'),
            ('assistant', f'好的，根据PRD开始UI设计。\n\n## {task_title} 设计方案\n\n### 设计风格\n- 简洁现代\n- 主色调与品牌一致\n- 响应式设计\n\n### 页面列表\n1. 主页面\n2. 详情页\n3. 设置页'),
            ('assistant', f'## UI设计完成 ✅\n\n- [x] 主页面设计\n- [x] 详情页设计\n- [x] 设置页设计\n- [x] 组件库\n- [x] 交互规范\n\n产出: 设计稿 + 组件库 + 规范文档'),
        ],
        'frontend': [
            ('user', f'设计稿确认，开始「{task_title}」前端开发'),
            ('assistant', f'收到，开始前端开发。\n\n## 技术方案\n- React + TypeScript\n- 状态管理: Zustand\n- 样式: Tailwind\n- 测试: Vitest'),
            ('assistant', f'## 前端开发完成 ✅\n\n- [x] 页面组件开发\n- [x] 状态管理\n- [x] API对接\n- [x] 响应式适配\n- [x] 单元测试(覆盖率85%)\n\n产出: 前端代码 + store + 测试'),
        ],
        'backend': [
            ('user', f'前端OK，开始「{task_title}」后端开发'),
            ('assistant', f'收到，开始后端开发。\n\n## 接口设计\n- RESTful API\n- JWT鉴权\n- 数据校验\n- 错误处理'),
            ('assistant', f'## 后端开发完成 ✅\n\n- [x] API接口开发\n- [x] 数据库设计\n- [x] 鉴权中间件\n- [x] 单元测试(覆盖率90%)\n\n产出: API服务 + 数据库 + 测试'),
        ],
        'test': [
            ('user', f'前后端完成，开始「{task_title}」集成测试'),
            ('assistant', f'收到，开始集成测试。\n\n## 测试计划\n- 功能测试\n- 接口测试\n- E2E测试\n- 性能测试'),
            ('assistant', f'## 测试完成 ✅\n\n| 测试类型 | 结果 | 通过率 |\n|----------|------|--------|\n| 功能测试 | ✅ | 100% |\n| 接口测试 | ✅ | 98% |\n| E2E | ✅ | 95% |\n| 性能 | ✅ | 达标 |\n\nBug: 2个P2已修复\n\n产出: 测试报告 + Bug列表'),
        ],
        'deploy': [
            ('user', f'测试通过，「{task_title}」准备上线'),
            ('assistant', f'收到，开始部署「{task_title}」。\n\n## 部署计划\n- 环境检查\n- 数据库迁移\n- 服务部署\n- 灰度发布'),
            ('assistant', f'## 部署完成 ✅\n\n| 步骤 | 状态 |\n|------|------|\n| 环境检查 | ✅ |\n| 数据库迁移 | ✅ |\n| 服务部署 | ✅ |\n| 灰度发布 | ✅ |\n\n监控正常，{task_title}已上线！'),
        ],
    }

    return templates.get(sk, [
        ('user', f'开始「{task_title}」的{sk_label}阶段'),
        ('assistant', f'收到，开始{sk_label}...\n\n分析中...'),
        ('assistant', f'## {sk_label}完成 ✅\n\n{task_title}的{sk_label}阶段已完成。\n\n产出: 相关文档和代码'),
    ])

# Process each task
for task in tasks:
    print(f"\n--- {task.title} ---")

    # Ensure all task steps exist
    for sk in step_keys:
        TaskStep.get_or_create(task=task, step_key=sk, defaults={'status': 'pending'})

    # Clear existing messages
    Message.delete().where(Message.task == task).execute()

    # Insert messages for each stage
    pos = 1
    task_base_time = now - (len(tasks) - tasks.index(task)) * 7200
    for sk_idx, sk in enumerate(step_keys):
        msgs = get_stage_messages(task.title, sk, sk_idx, len(step_keys))
        stage_base_time = task_base_time + sk_idx * 1200
        for i, (role, content) in enumerate(msgs):
            created_at = stage_base_time + i * 180
            events = [
                {'type': 'text_delta', 'data': {'delta': content[:80]}, 'timestamp': created_at * 1000},
                {'type': 'usage', 'data': {'input_tokens': 500, 'output_tokens': len(content)}, 'timestamp': (created_at + 30) * 1000},
            ]
            Message.create(
                id=str(uuid.uuid4()),
                task=task, step_key=sk, role=role,
                content=content, run_status='succeeded',
                events_json=json.dumps(events),
                position=pos, created_at=created_at,
            )
            pos += 1
        print(f"  {sk}: {len(msgs)} messages")

    # Update step statuses (all passed except last which is running)
    for sk in step_keys[:-1]:
        TaskStep.update(status='passed').where((TaskStep.task == task) & (TaskStep.step_key == sk)).execute()
    if step_keys:
        TaskStep.update(status='running').where((TaskStep.task == task) & (TaskStep.step_key == step_keys[-1])).execute()

    total = Message.select().where(Message.task == task).count()
    print(f"  Total: {total} messages")

grand_total = Message.select().count()
print(f"\n=== Grand total: {grand_total} messages across {len(tasks)} tasks ===")
print("Done!")
