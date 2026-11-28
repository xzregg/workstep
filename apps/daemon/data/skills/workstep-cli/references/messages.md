# Project conversations

## Archive a conversation

With explicit user authorization and both WorkStep IDs, archive an idle
ordinary project conversation:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli session archive --project <project_id> --session <session_id> --json
```

Use [Transport](transport.md) for other runtimes. Native operation:
`workstep_archive_chat_session` with `project_id`, `session_id`, and
`confirm: "yes"`. Project-scoped callers need edit access to the target project.

Report `archived: true` as archived with history retained. Report
`deleted: true` as an empty conversation cleared by the existing archive rule.
Archiving clears the conversation's schedules. Report `ok: false` or a nonzero
exit as failure. If a turn is queued, running, or stopping, report the conflict
and leave the turn alone.

For delegated work, use the record's `project_id` and `session_id`. The
delegation record stays in history and its archived execution conversation
cannot accept a delegation continuation. Workflow tasks use their own
[`task archive`](tasks.md) command.

## Send an instruction

For the digital hub, use [tracked delegation](digital-person.md)
with `--target-session` to send and follow up.

With explicit user authorization and both WorkStep IDs, submit a new turn to an
existing ordinary project chat:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli message send --project <project_id> --session <session_id> --content "Instruction to execute" --json
```

Native operation: `workstep_send_message` with `project_id`, `session_id`,
`content`, and `confirm: "yes"`. Use the target IDs and the usual daemon
authentication. Project-scoped callers need edit access to the target project.

`queued` means the daemon accepted the turn. A busy conversation finishes its
current turn first, and the new turn uses the same conversation history and saved
execution settings. The response includes `session_id`, `turn_id`, and
`assistant_message_id`. Check the target conversation or use `message get` with
`assistant_message_id` for the saved result.

For a possible retry, supply `--idempotency-key` (native `idempotency_key`) on the
first attempt and reuse it for the same instruction while the daemon retains
the turn. Omit it to generate a fresh key. Report `ok: false` or a nonzero exit
as a failed request. A timeout can occur after acceptance, so check before retrying.

## Read a saved message

When given a WorkStep session ID and message ID, read that message directly:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli message get --session <session_id> --message <message_id> --project <project_id> --json
```

Use the invocation alternatives in [Transport](transport.md). This reads the
original persisted chat message, not memory or derived knowledge. It returns
the complete saved `content`, role, status, author, timestamps, and project/session
IDs. It does not load other messages, prompts, or process events. A running
message contains only the content persisted so far.

A new session in a project with an 8-character ID starts with those eight
characters and ends with an 18-character sortable suffix. Pass the project ID
explicitly to address its database directly. Older hyphenated session IDs can
still resolve their project through the existing lookup. For an ID without a
recognized legacy prefix, an unscoped local request that omits `--project`
searches registered projects for the exact message. Project-scoped remote access
stays within the authorized project. A mismatched session or message returns an
error.

Use `--fields id,content,role` to select top-level fields. Read-only lookup
requires no mutation confirmation. Missing access, connection errors, and not
found responses must be reported as failures.
