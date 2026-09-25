"""The flow choice projection is shared by live delivery and saved replies."""

import json

from agent_assistants.workflow_choice_ui import ensure_flow_choice_ui


STEPS = {"nodes": [{"id": 1, "type": "req", "title": "需求"}], "connections": []}


def test_generates_choice_events_for_plain_reply():
    reply, payloads = ensure_flow_choice_ui(
        "请选择方案",
        [{"title": "简单版", "summary": "一步完成", "steps": STEPS}],
    )
    assert reply == "请选择方案"
    assert len(payloads) == 2
    components = payloads[1]["updateComponents"]["components"]
    button = next(item for item in components if item["component"] == "Button")
    assert button["action"]["event"]["name"] == "apply_flow"
    assert json.loads(button["action"]["event"]["context"]["stepsJson"]) == STEPS


def test_existing_fence_gets_steps_and_proposal_id_without_duplicate_events():
    reply = (
        "选择\n```a2ui\n"
        '{"updateComponents":{"components":[{"component":"Button",'
        '"action":{"event":{"name":"apply_flow",'
        '"context":{"proposal":1}}}}]}}\n'
        "```\n"
    )
    enriched, payloads = ensure_flow_choice_ui(
        reply, [{"id": "proposal-a", "steps": STEPS}]
    )
    assert payloads == []
    assert enriched.count("```a2ui") == 1
    update = json.loads(enriched.splitlines()[2])
    context = update["updateComponents"]["components"][0]["action"]["event"]["context"]
    assert context["proposalId"] == "proposal-a"
    assert json.loads(context["stepsJson"]) == STEPS
    assert ensure_flow_choice_ui(reply, []) == (reply, [])
