---
name: workstep-cli
description: Manage WorkStep projects, workflows, tasks, quick buttons, engines and schedules. Trigger proactive reflection. Query historical memories, user preferences and reusable experience. Decide whether retrieval is needed; also use for reminders.
---

# WorkStep CLI

Read only the reference needed for the operation.

## Invocation

Read [Transport](references/transport.md) before the first call or after a transport
failure. It covers native `workstep_call`, source checkout, packaged desktop,
Windows, inherited runtime variables and missing-environment recovery.

From a project with the inherited daemon directory:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli <resource> <action> [options]
```

Use documented transports rather than constructing HTTP requests or inspecting
daemon source. Never guess interpreter paths, ports or credentials, persist runtime
credentials, or edit generated skill mirrors.

Use `context get --json` for the current project/conversation IDs
(`WORKSTEP_PROJECT_ID`, `WORKSTEP_SESSION_ID`), not engine thread IDs.

## Operations

| Need | Read |
| --- | --- |
| Save standing agreements, trigger/stop digital-person reflection or delegate work | [Digital person](references/digital-person.md) |
| Send an instruction to an existing project chat or read an original message | [Messages](references/messages.md) |
| Historical memories, experience, original evidence and time review | [Memory](references/memory.md) |
| Summary/detail output, fields, limits and pagination | [Output](references/output.md) |
| Projects, quick buttons and Actions | [Projects](references/projects.md) |
| Workflows, step keys, buttons and Actions | [Workflows](references/workflows.md) |
| Tasks, execution, archive lessons, worktrees and stage controls | [Tasks](references/tasks.md) |
| Reminders, recurring/one-time schedules and scheduled task instructions | [Schedules](references/schedules.md) |
| Bots, sessions, notifications, bindings and files | [Channels](references/channels.md) |
| Engines, skill drafts and skins | [Extensions](references/extensions.md) |
| Creating/importing execution engines | [Engine guides](references/custom-engine.md) |
| Custom languages | [Languages](references/custom-language.md) |

## Execution rules

- Resolve IDs with list/get; never invent IDs.
- Reads need no confirmation. Mutate only with current authorization; send
  notices only as the operation reference allows.
- Read full task/workflow state before stage controls; `--start-step` uses a step key.
- Start with compact summaries and selected details. Read remaining pages before
  claiming complete coverage; use `--verbose` only when full data is needed.
- Check returned JSON and exit status. `{"ok": false}` is failure; queued is not
  delivered. Deduplicate bulk creations, respect the requested count and report failures.
