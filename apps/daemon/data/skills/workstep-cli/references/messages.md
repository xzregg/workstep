# Project chat messages

## Send an instruction

For the digital person, use [tracked delegation](digital-person.md)
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
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli message get --session <session_id> --message <message_id> --json
```

Use the invocation alternatives in [Transport](transport.md). This reads the
original persisted chat message, not memory or derived knowledge. It returns
the complete saved `content`, role, status, author, timestamps, and project/session
IDs. It does not load other messages, prompts, or process events. A running
message contains only the content persisted so far.

New session IDs replace the first UUID segment with the complete project ID:
`<project_id>-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. The project prefix locates its database
directly; the remaining random segments keep sessions unique. These are WorkStep
conversation IDs, not engine thread IDs.

Legacy UUID sessions remain readable. Add `--project <project_id>` when known
to address the database directly; without it, the local host checks registered
projects for that exact message. Project-scoped remote access to legacy sessions
requires `--project`; it cannot search other projects. Unknown or mismatched
session/message IDs return an error, never a different message.

Use `--fields id,content,role` to select top-level fields. Read-only lookup
requires no mutation confirmation. Missing access, connection errors, and not
found responses must be reported as failures.
