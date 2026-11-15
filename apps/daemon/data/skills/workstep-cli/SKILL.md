---
name: workstep-cli
description: Inspect and manage WorkStep projects, workflows, tasks, quick buttons, engines, schedules, and shared memories. For memory, infer entity dimensions, locate typed names/aliases, narrow relationships and verify originals; review dates first when needed. Use when asked to check, remind, or act later in this conversation.
---

# WorkStep CLI

Use this skill when the user asks to inspect or manage WorkStep itself: projects,
workflows, tasks, quick buttons, LLM engines, schedules, or shared memories. Also use when asked
to check, remind, or act later in this conversation (for example, “两小时后检查”).

Read the relevant reference before each operation.

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

Add `--json` for structured output. Memory commands default to concise text;
`--json` keeps the same compact fields, while `--verbose` requests full metadata.
The CLI reads the daemon URL and temporary authentication from its
environment. Use `--url <url>` before the resource only for an explicit override.
On policy rejection, try the next applicable transport; if none works, report it.
See [transport](references/transport.md) for PowerShell/cmd syntax and first-run
repair rules. Never persist runtime URLs, tokens or resource IDs, and never edit
generated skill mirrors.

Runtime variables come from daemon startup and are inherited by engine processes:
`WORKSTEP_DAEMON_DIR` is the running daemon's code directory;
`WORKSTEP_CLI_PYTHON` is its `sys.executable` (not your project virtualenv);
`WORKSTEP_DAEMON_URL` identifies the running daemon. The CLI resolves local
authentication automatically. If an engine shell lacks these variables, follow
the missing-environment rules in [transport](references/transport.md); never
guess an installation path, Python interpreter, port or credential.

## Current conversation

Use `context get --json` with the CLI transport above to read the current
WorkStep project and conversation IDs from the execution environment. Only
`WORKSTEP_PROJECT_ID` and `WORKSTEP_SESSION_ID` are provided; no message ID is
needed. Do not confuse these with engine thread IDs or dump the full environment.
Outside a conversation the command returns an error; do not guess a target.

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
| Search memories, read original evidence, review a time range, fetch an assigned background assessment batch | [Memory](references/memory.md) |
| Output fields, limits, filters, summaries | [Output](references/output.md) |
| Projects, project quick buttons and Actions | [Projects](references/projects.md) |
| Workflows, step keys, workflow buttons and Actions | [Workflows](references/workflows.md) |
| Tasks, lifecycle, archive lessons, reviews, worktrees, stage controls | [Tasks](references/tasks.md) |
| Act later in this conversation, recurring/one-time schedules, existing-task instructions | [Schedules](references/schedules.md) |
| Bots, sessions, notifications, group binding, files | [Channels](references/channels.md) |
| Engines, skill drafts, skins | [Extensions](references/extensions.md) |
| Custom language creation | [Languages](references/custom-language.md) |

## Keep output small

Memory CLI returns compact titles/summaries, source IDs and coverage; use `read`
or `--with-sources` for originals. Interpret intent into person/event/object/place/time
filters; locate entities/aliases, then narrow relationships (`--person 小林`, then
`--person 小林 --relation 负责`). For time investigations, review the period's
records first, derive entity names and symptoms from evidence, then search knowledge.
See [Memory](references/memory.md) for matching, pagination and examples.

Lists return summaries by default; `--verbose` includes full data. Use optional
`--limit 20` and `--fields id,name` (tasks: `id,title,status`) to locate resources,
then request details only for selected IDs. Read more pages when `remaining > 0`;
never mistake a limited page for all matches. Limits/field selection are local
output controls. Existing command defaults and error responses stay intact.

`task list` supports `--archived`, `--status` and `--workflow` filters.
`--fields` also works on `get`; missing fields are omitted. Read full task and
workflow state before stage controls. See Output for exact semantics and examples.

## Custom-engine MCP connector contract

When creating or importing an execution engine, read the MCP section in `references/custom-engine-contract.md`. Require an honest `supports_mcp` declaration and, when true, an explicit async `configure_mcp_servers(servers, config_overrides=None)` implementation consumed by real SDK/CLI/ACP execution and resume. Preserve native MCP configuration, approval and secret boundaries. `engine validate` must pass `mcp_connector_roundtrip`, which verifies real calls to an isolated MCP service; text claims or a capability flag alone are insufficient.
