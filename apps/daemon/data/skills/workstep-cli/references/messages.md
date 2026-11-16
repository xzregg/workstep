# Original chat messages

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
