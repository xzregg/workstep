"""A2UI choice projection for workflow proposals."""

import json
import re


def _has_a2ui_fence(content: str) -> bool:
    """True when the reply already contains a complete ```a2ui fence."""
    return re.search(
        r"^```a2ui[ \t]*\r?\n[\s\S]*?^```[ \t]*\r?\n?",
        content,
        re.MULTILINE,
    ) is not None


def ensure_flow_choice_ui(reply: str, proposals: list[dict]) -> tuple[str, list[dict]]:
    """保证方案选择界面：返回 (reply, a2ui 事件载荷列表)。

    模型自带 `````a2ui```` fence 时保留 fence（并注入 stepsJson），UI 走
    fence 渲染、不发事件；否则自动生成 createSurface + updateComponents
    作为 ``a2ui`` 事件推送，reply 只留文本摘要。
    """
    if not proposals:
        return reply, []
    if _has_a2ui_fence(reply):
        return _inject_a2ui_flow_steps(reply, proposals), []
    components: list[dict] = [
        {
            "component": "Text",
            "id": "hint",
            "text": "请选择一个方案（点击按钮应用到画布）",
        }
    ]
    root_children: list[str] = ["hint"]
    for index, item in enumerate(proposals, start=1):
        # A2UI Button.child 引用的是组件 id，按钮文字由独立的 Text 标签提供。
        label_id = f"l{index}"
        button_id = f"p{index}"
        components.append(
            {
                "component": "Text",
                "id": label_id,
                "text": item.get("title") or f"方案 {index}",
            }
        )
        components.append(
            {
                "component": "Button",
                "id": button_id,
                "child": label_id,
                "variant": "primary" if index == 1 else "default",
                "action": {
                    "event": {
                        "name": "apply_flow",
                        "context": {
                            "proposal": index,
                            "stepsJson": json.dumps(
                                item["steps"],
                                ensure_ascii=False,
                                separators=(",", ":"),
                            ),
                        },
                    }
                },
            }
        )
        root_children.extend([label_id, button_id])
        summary = item.get("summary")
        if summary:
            summary_id = f"s{index}"
            components.append(
                {
                    "component": "Text",
                    "id": summary_id,
                    "text": summary,
                    "variant": "caption",
                }
            )
            root_children.append(summary_id)
    components.insert(
        0,
        {
            "component": "Column",
            "id": "root",
            "children": root_children,
        },
    )
    payloads = [
        {
            "version": "v0.9.1",
            "createSurface": {
                "surfaceId": "flow-choice",
                "catalogId": "basic",
            },
        },
        {
            "version": "v0.9.1",
            "updateComponents": {
                "surfaceId": "flow-choice",
                "components": components,
            },
        },
    ]
    # reply 只留文本摘要；UI 以 a2ui 事件推送（前端 store 渲染）。
    return reply.rstrip(), payloads


def _inject_a2ui_flow_steps(reply: str, proposals: list[dict]) -> str:
    """Make model-authored apply buttons self-contained across refreshes."""
    fence_pattern = re.compile(
        r"(^```a2ui[ \t]*\r?\n)([\s\S]*?)(^```[ \t]*\r?\n?)",
        re.MULTILINE,
    )

    def enrich(match: re.Match) -> str:
        body = match.group(2)
        messages = []
        decoder = json.JSONDecoder()
        index = 0
        try:
            while index < len(body):
                while index < len(body) and body[index].isspace():
                    index += 1
                if index >= len(body):
                    break
                message, index = decoder.raw_decode(body, index)
                messages.append(message)
        except (json.JSONDecodeError, TypeError):
            return match.group(0)

        changed = False
        for message in messages:
            update = message.get("updateComponents") if isinstance(message, dict) else None
            components = update.get("components") if isinstance(update, dict) else None
            if not isinstance(components, list):
                continue
            for component in components:
                if not isinstance(component, dict) or component.get("component") != "Button":
                    continue
                action = component.get("action")
                event = action.get("event") if isinstance(action, dict) else None
                if not isinstance(event, dict) or event.get("name") != "apply_flow":
                    continue
                context = event.get("context")
                if not isinstance(context, dict) or "stepsJson" in context:
                    continue
                try:
                    proposal_index = int(context.get("proposal")) - 1
                    steps = proposals[proposal_index]["steps"]
                except (TypeError, ValueError, IndexError, KeyError):
                    continue
                context["stepsJson"] = json.dumps(
                    steps, ensure_ascii=False, separators=(",", ":")
                )
                proposal_id = proposals[proposal_index].get("id") if isinstance(proposals[proposal_index], dict) else None
                if proposal_id:
                    context["proposalId"] = proposal_id
                changed = True
        if not changed:
            return match.group(0)
        body = "\n".join(json.dumps(item, ensure_ascii=False) for item in messages)
        return f"{match.group(1)}{body}\n{match.group(3)}"

    return fence_pattern.sub(enrich, reply)
