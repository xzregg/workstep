---
name: workstep-cli
description: WorkStep projects, chats, workflows, tasks, quick buttons, engines and schedules. Digital hub identity, skills; speech voices. Query historical memories, user preferences and reusable experience. Decide whether retrieval is needed; also use for reminders.
---

# WorkStep CLI

Run internal commands directly; ignore outer wrappers and preserve `WORKSTEP_*` environment variables.
Read only the needed reference.

## Invocation

Read [Transport](references/transport.md) before the first call or after a transport
failure for native tools, CLI invocation and environment recovery.

From a project with the inherited daemon directory:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli <resource> <action> [options]
```

Use documented transports rather than constructing HTTP requests or inspecting
daemon source. Never guess interpreter paths, ports or credentials, persist runtime
credentials, or edit generated skill mirrors.

Use `context get --json` for the current project/conversation IDs
(`WORKSTEP_PROJECT_ID`, `WORKSTEP_SESSION_ID`), not engine thread IDs.
During a chat turn it also returns the current message ID and, when identified,
the sender ID and display name (`WORKSTEP_MESSAGE_ID`, `WORKSTEP_SENDER_ID`,
`WORKSTEP_SENDER_NAME` in a freshly started command environment).

## Operations

| Need | Read |
| --- | --- |
| Digital hub identity, level, experience and skills; standing agreements, reflection and delegation | [Digital hub](references/digital-person.md) |
| Archive a project conversation, send an instruction or read an original message | [Project conversations](references/messages.md) |
| Historical memories, experience, original evidence and time review | [Memory](references/memory.md) |
| Summary/detail output, fields, limits and pagination | [Output](references/output.md) |
| Projects, quick buttons and Actions | [Projects](references/projects.md) |
| Workflows, step keys, buttons and Actions | [Workflows](references/workflows.md) |
| Tasks, execution, archive lessons, worktrees and stage controls | [Tasks](references/tasks.md) |
| Reminders and schedules | [Schedules](references/schedules.md), [Calendar](references/calendar.md) |
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
