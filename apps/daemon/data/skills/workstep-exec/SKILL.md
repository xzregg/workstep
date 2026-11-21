---
name: workstep-exec
description: Turn an idea in project chat into a workflow. Only for repeatable, standardizable work; not for one-off tasks. Define nonempty step artifacts and map upstream outputs to downstream inputs. Present a diagram first; after user confirmation, create the workflow and task, start execution, and provide a task details button.
---

# Workflow Mode

## Only create a workflow for repeatable work

A one-off task is not worth a dedicated workflow. Check whether the work will recur or form a process worth standardizing.

- For a one-off task without an explicit workflow request, briefly explain why a workflow is unnecessary and use `task create` without `--workflow` for the project default (see `workstep-cli`). If repeatability is unclear, ask one concise question.
- For repeatable work or an explicit workflow request, use the process below. If a workflow already fits, skip `workflow create` and use `--workflow <existing_id>` when creating the task.

## Language

Respond in the user's language unless asked otherwise. Localize all user-facing text, including saved workflow and task text, step prompts, diagrams, button labels, action instructions, and errors. Preserve skill identifiers, tool names, commands, JSON keys, action event names, resource IDs, and returned URLs.

## Present the diagram, then request confirmation

1. Derive the goal, inputs, outputs, constraints, and acceptance criteria from the current conversation. Ask only for essential missing information.
2. Tailor the steps to the work. Define responsibilities, prompts, and dependencies; independent steps may run in parallel. Give every step, including the last, at least one concrete artifact with a name, file format or directory type, and required contents. Identify the upstream artifact each downstream step consumes. Resolve missing or placeholder artifacts and handoffs before asking for confirmation.
3. Start with a basic `mermaid` flowchart in its own fence with double-quoted node labels. Follow it with the steps and handoffs, workflow name, task title, complete task description, and acceptance criteria. The workflow name must be nonempty and contain no whitespace.
4. Update the diagram and step descriptions after each revision. End the proposal with the localized "Create and start" A2UI button below, keeping its JSON structure and one object per line. Wait for the user to approve the latest plan via a `confirm_workflow_creation` message or a direct instruction to create and execute it. Until then, do not create resources, edit project code, run development tasks, or start steps.

```a2ui
{"version":"v0.9.1","createSurface":{"surfaceId":"workstep-exec-confirm","catalogId":"basic"}}
{"version":"v0.9.1","updateComponents":{"surfaceId":"workstep-exec-confirm","components":[{"id":"root","component":"Column","children":["confirm"]},{"id":"confirm-label","component":"Text","text":"Create and start"},{"id":"confirm","component":"Button","child":"confirm-label","variant":"primary","action":{"event":{"name":"confirm_workflow_creation","context":{"instruction":"Confirm creation of one new workflow and one task in the current project using the plan shown in this message, then start the task."}}}}]}}
```

## Create resources after confirmation

Prefer native WorkStep tools. If unavailable, use the supported CLI from the built-in `workstep-cli` skill. In a source checkout, use `uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli`; in this repository, `uv run --no-sync --directory apps/daemon python -m cli` is also supported. In a packaged desktop environment, use `"$WORKSTEP_CLI_PYTHON" "$WORKSTEP_DAEMON_DIR/cli.py"`. Below, `<cli>` stands for the selected command prefix, not an executable name. Add `--json` to every invocation. Do not construct HTTP requests yourself, guess ports, read credentials, or modify databases directly.

1. Match `project list` to the current working directory and known project context; ask if ambiguous. Check `workflow list` and reuse execution defaults. Query `engine list` when selecting an engine, model, or provider. Use real IDs and configurations.
2. Verify that the canvas matches the confirmed diagram and dependencies. Give nodes unique positive integer `id` values, unique `type` identifiers matching `[A-Za-z][A-Za-z0-9_-]*`, and numeric `position.x` and `position.y`. Connect existing nodes and keep forward dependencies acyclic. Each node needs a nonempty `outputs` array with concrete `name` and `type` values. Connect each forward edge from a declared output (`fromPort`) to its consumer's declared input (`toPort`). Prompts must specify what to read and what substantive content to write at each declared output path. If anything is missing or unclear, revise and get confirmation before creating. Save the confirmed canvas to a temporary JSON file, then run the command below.

   `<cli> workflow create --project <project_id> --name <workflow_name> --steps-file <temporary_json_file> --json`

   The native operation is `workstep_create_workflow(project_id, name, steps, confirm="yes")`, where `steps` is the canvas shown in the example below.

   ```json
   {"nodes":[{"id":1,"type":"investigate","title":"Analyze the problem","prompt":"Write the problem analysis at its declared output path with the scope, constraints, and acceptance criteria.","outputs":[{"name":"Problem analysis","type":"Markdown"}],"position":{"x":80,"y":80}},{"id":2,"type":"deliver","title":"Deliver the result","prompt":"Read the problem analysis, complete the task, and write the delivery report at its declared output path with the result and evidence for each acceptance criterion.","inputs":[{"name":"Problem analysis","type":"Markdown"}],"outputs":[{"name":"Delivery report","type":"Markdown"}],"position":{"x":400,"y":80}}],"connections":[{"from":1,"fromPort":0,"to":2,"toPort":0,"kind":"solid"}]}
   ```

   Do not modify existing workflows or the project's default workflow.
3. After successful workflow creation, use the returned ID to create one task with automatic startup disabled.

   `<cli> task create --project <project_id> --workflow <returned_workflow_id> --title <task_title> --desc <task_description_and_acceptance_criteria> --no-auto-start --json`

   Use the same fields with `workstep_create_task` and add `auto_start=false, confirm="yes"`.
4. Record the task ID and `task_detail_url` from the successful response, then start that task.

   `<cli> task run --project <project_id> --task <returned_task_id> --json`

   Use `workstep_run_task(project_id, task_id, confirm="yes")` for native execution. Acknowledgment of the start request confirms submission only.
5. Report `ok=false`, nonzero exits, and interrupted requests accurately. Preserve any workflow or task already created, including after startup failure. Before retrying an uncertain result, verify it with list/get. For repeated confirmations, check prior creation results to avoid duplicate resources or restarting a running task.

## Always include the task details button after task creation

Once the task exists, report the workflow and task names and actual startup status, including any startup failure. WorkStep renders the localized link below as a button when it uses the exact returned `task_detail_url`.

```markdown
[Open task details](<task_detail_url>)
```

Include the link only with a URL from successful task creation. Earlier buttons remain usable.
