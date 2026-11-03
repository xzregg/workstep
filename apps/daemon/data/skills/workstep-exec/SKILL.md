---
name: workstep-exec
description: Turn an idea in project chat into a workflow. Present a diagram first; after user confirmation, create the workflow and task, start execution, and provide a task details button.
---

# Workflow Mode

Use the requirements in the current conversation to plan work steps, create a workflow and task in the current WorkStep project, and execute them. Present the plan first. Wait for explicit user confirmation before creating resources or starting execution.

## Language

Respond in the user's language unless they explicitly request another language. Localize all user-facing text, including questions, diagrams, step titles and prompts, workflow names, task titles and descriptions, acceptance criteria, confirmation buttons, task details links, status messages, and errors. The English labels and prose in the examples below are examples to translate, not a requirement to respond in English. Keep skill identifiers, tool names, commands, JSON keys, action event names, resource IDs, and returned URLs unchanged.

## Present the diagram, then request confirmation

1. Use the current conversation to understand the goal, inputs, outputs, constraints, and acceptance criteria. Ask concise questions when essential information is missing; otherwise, propose a plan directly.
2. Break the actual requirements into steps dynamically. Define each step's responsibility, prompt, output, and dependencies. Do not mechanically apply a fixed requirements/development/testing template. Independent steps may run in parallel.
3. Begin the proposal with a basic Mermaid flowchart in a separate `mermaid` code fence, with node labels enclosed in double quotes. Then describe the steps, proposed workflow name, task title, complete task description, and acceptance criteria.
4. Workflow names must be nonempty and contain no whitespace, including spaces, tabs, or newlines. Canvas node `id` values must be unique positive integers. Store each step identifier in `type`: it must start with an English letter, use only English letters, digits, underscores, or hyphens, and be unique within the workflow. Use `position: {"x":number,"y":number}` for layout. The diagram, dependencies, and created definition must agree.
5. Let the user revise the plan through conversation. Update the diagram and step descriptions after each revision; use only the latest confirmed version. Before confirmation, do not create workflows or tasks, modify project code, run development tasks, or start any steps.
6. End the proposal with a localized "Create and start" confirmation button using the following A2UI fence (one JSON object per line). Generating the button does not constitute user confirmation. Proceed to the next section only after receiving its `confirm_workflow_creation` user message or an explicit user instruction to confirm creation and execution. Translate the button text and the natural-language `instruction` value into the user's language; preserve the event name and JSON structure.

```a2ui
{"version":"v0.9.1","createSurface":{"surfaceId":"workstep-exec-confirm","catalogId":"basic"}}
{"version":"v0.9.1","updateComponents":{"surfaceId":"workstep-exec-confirm","components":[{"id":"root","component":"Column","children":["confirm"]},{"id":"confirm-label","component":"Text","text":"Create and start"},{"id":"confirm","component":"Button","child":"confirm-label","variant":"primary","action":{"event":{"name":"confirm_workflow_creation","context":{"instruction":"Confirm creation of one new workflow and one task in the current project using the plan shown in this message, then start the task."}}}}]}}
```

## Create resources after confirmation

Prefer native WorkStep tools. If unavailable, use the supported CLI from the built-in `workstep-cli` skill. In a source checkout, use `uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli`; in this repository, `uv run --no-sync --directory apps/daemon python -m cli` is also supported. In a packaged desktop environment, use `"$WORKSTEP_CLI_PYTHON" "$WORKSTEP_DAEMON_DIR/cli.py"`. Below, `<cli>` stands for the selected command prefix, not an executable name. Add `--json` to every invocation. Do not construct HTTP requests yourself, guess ports, read credentials, or modify databases directly.

1. Use `project list` to identify the current project's real ID by matching the working directory and known project context; ask if ambiguous. Read that project's `workflow list` and, when needed, `engine list`. Reuse available project execution defaults; never invent resource IDs or engine configurations.
2. Save the complete confirmed workflow definition to a temporary JSON file, then call:

   `<cli> workflow create --project <project_id> --name <workflow_name> --steps-file <temporary_json_file> --json`

   The corresponding native operation is `workstep_create_workflow(project_id, name, steps, confirm="yes")`. `steps` is a canvas object. This example illustrates the format only; generate the actual steps dynamically from the requirements:

   ```json
   {"nodes":[{"id":1,"type":"investigate","title":"Analyze the problem","prompt":"Analyze the task description and identify the problem and acceptance criteria","position":{"x":80,"y":80}},{"id":2,"type":"deliver","title":"Deliver the result","prompt":"Complete the task using the upstream analysis and verify each acceptance criterion","position":{"x":400,"y":80}}],"connections":[{"from":1,"fromPort":0,"to":2,"toPort":0,"kind":"solid"}]}
   ```

   Connection endpoints must reference real node IDs, and ordinary dependencies must not form cycles. Query available configurations before specifying an engine, model, or provider. Do not modify existing workflows or the project's default workflow.
3. Check the successful response and use the returned workflow ID to create one task. Disable automatic startup so that a startup failure still leaves a clearly identified task:

   `<cli> task create --project <project_id> --workflow <returned_workflow_id> --title <task_title> --desc <task_description_and_acceptance_criteria> --no-auto-start --json`

   The corresponding native operation is `workstep_create_task`, with the same fields plus `auto_start=false, confirm="yes"`.
4. Record the task ID and `task_detail_url` from the successful response, then call:

   `<cli> task run --project <project_id> --task <returned_task_id> --json`

   The corresponding native operation is `workstep_run_task(project_id, task_id, confirm="yes")`. Start only the task just created. Do not describe an accepted execution request as completed work.
5. Never claim success after `ok=false`, a nonzero exit code, or an interrupted request. Preserve and reuse any workflow or task already created; do not create another task because startup failed. When the result is uncertain, verify it with list/get before retrying. Never blindly retry creation. For repeated confirmation clicks, check the creation results already recorded in the conversation; do not create duplicates or restart a running task.

## Always include the task details button after task creation

After successful task creation, briefly report the workflow name, task name, and actual startup status, then output a localized link in this form:

`[Open task details](task_detail_url)`

Translate the link label into the user's language. Replace `task_detail_url` in parentheses with the exact real value returned by the successful tool response. WorkStep renders this link as a button that opens task details inside the application. Do not output a literal placeholder, guess task IDs, construct a host address, or claim that a button exists without including the link.

If task creation succeeded but startup failed, still include the same task details button and explain the startup failure. If task creation failed, do not invent a button. Buttons in earlier replies should remain usable.
