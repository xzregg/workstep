---
name: workstep-cli
description: Inspect and manage WorkStep projects, workflows, tasks, quick buttons, engines, and schedules through the local daemon CLI or native WorkStep tools.
---

# WorkStep CLI

Use this skill when the user asks to inspect or manage WorkStep itself: projects,
workflows, tasks, quick buttons, LLM engines, or schedules.

Use this skill to inspect or manage WorkStep. Read only the relevant topic below
before its operations; do not load all references.

## Transport

The CLI is the supported HTTP adapter. Do not construct daemon HTTP requests directly
or inspect daemon source to rediscover routes, schemas, URLs or authentication.
Use this order; do not probe with `echo`, `pwd`, or `which`:

1. If `workstep_call` is in the actual tool list, use its matching operation.
2. In this source checkout:
   `uv run --no-sync --directory apps/daemon python -m cli <resource> <action> [options]`
   From another project:
   `uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli <resource> <action> [options]`
3. In packaged desktop:
   `"$WORKSTEP_CLI_PYTHON" "$WORKSTEP_DAEMON_DIR/cli.py" <resource> <action> [options]`
4. When the `workstep` executable is already known to be available:
   `workstep <resource> <action> [options]`.

Add `--json`. The CLI reads the daemon URL and temporary authentication from its
environment. Use `--url <url>` before the resource only for an explicit override.
On policy rejection, try the next applicable transport; if none works, report it.
See [transport](references/transport.md) for PowerShell/cmd syntax and first-run
repair rules. Never persist runtime URLs, tokens or resource IDs, and never edit
generated skill mirrors.

## Safety rules

- List or get resources before using their IDs. Never invent project, workflow,
  task, schedule, or step IDs.
- Read-only list/get operations may run without confirmation.
- Create, update, pause, resume, delete, and project initialization have side
  effects. Run them only when the current user request or scheduled instruction
  explicitly authorizes that action.
- Inspect a workflow before choosing `--start-step`; use the step key, not the
  display title.
- After a mutation, inspect the returned JSON. Do not claim success when the
  response contains `{"ok": false}` or the command exits non-zero.
- For multiple task creations, apply a clear user-requested limit, deduplicate
  candidates, and report individual failures instead of retrying indefinitely.


## Read the relevant topic

| Need | Reference |
| --- | --- |
| Output fields, limits, filters, summaries | [Output](references/output.md) |
| Projects, project quick buttons and Actions | [Projects](references/projects.md) |
| Workflows, step keys, workflow buttons and Actions | [Workflows](references/workflows.md) |
| Tasks, repositories, worktrees, stage start/stop/messages | [Tasks](references/tasks.md) |
| Recurring/one-time schedules, existing-task instructions | [Schedules](references/schedules.md) |
| Bots, sessions, notifications, group binding, files | [Channels](references/channels.md) |
| Engines, skill drafts, skins | [Extensions](references/extensions.md) |
| Custom language creation | [Languages](references/custom-language.md) |

## Keep output small

Lists return summaries by default; `--verbose` includes full data. Use optional
`--limit 20` and `--fields id,name` (tasks: `id,title,status`) to locate resources,
then request details only for selected IDs. Read more pages when `remaining > 0`;
never mistake a limited page for all matches. Limits/field selection are local
output controls. Existing command defaults and error responses stay intact.

`task list` supports `--archived`, `--status` and `--workflow` filters.
`--fields` also works on `get`; missing fields are omitted. Read full task and
workflow state before stage controls. See Output for exact semantics and examples.
