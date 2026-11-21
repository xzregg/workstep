## Channel notifications

List robots and active channel sessions to resolve the exact recipient first:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli channel list --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli channel sessions --project <project_id> --json
```

Send only when explicitly requested by the user or authorized by a scheduled
instruction. This sends an external notification immediately, without starting
an LLM turn or adding it to the conversation history. Never invent recipient IDs.
Prefer a listed session to avoid confusing users, groups, or different robots:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli channel send \
  --project <project_id> --session <session_id> --text "Task completed" --json
```

For an explicitly specified recipient, use one robot and exactly one platform
user ID or group ID. The robot must belong to the project, or the group must be
bound to a task in that project:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli channel send \
  --project <project_id> --bot <bot_id> --user <platform_user_id> --text "Task completed" --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli channel send \
  --project <project_id> --bot <bot_id> --group <platform_group_id> --text "Task completed" --json
```

Do not combine `--session` with `--bot`, `--user`, or `--group`. Archived or
reset sessions and disabled robots cannot send. Native operations are
`workstep_list_channel_bots`, `workstep_list_channel_sessions`, and
`workstep_send_channel_message` (mutating, requires `confirm='yes'`). Check
`sent: true` before reporting success; transport failures return non-zero.



## Bind the current channel group to a task

When a user explicitly asks in a group to bind that group to an existing task,
use the `session_id` and `project_id` from the channel session's system
background. Do not copy a group ID from user text. Confirm the task ID with
`task list` or `task get`, then bind the current group:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli channel bind \
  --session <current_channel_session_id> --project <project_id> \
  --task <existing_task_id> --json
```

The equivalent native operation is `workstep_bind_channel_group` with
`session_id`, `project_id`, `task_id`, and `confirm='yes'`. The daemon resolves
the robot and group from the active session and rejects private chats, reset
sessions, tasks outside the session's project, and groups bound to another
task. Inspect the returned JSON before telling the user the binding succeeded.
Future group messages route to that task's coordinator.

## Unbind a task discussion group

When the user requests unbinding, use the exact project, task, bot and group IDs
from the binding or the current coordinator's group request background
(`bot_id` and `conversation_id`). If the binding is ambiguous, ask which group
to unbind rather than guessing. For a request from the current channel group to
unbind that same group, add `--notify` unless the user asks for silence. Never
use historical channel metadata. For other requests only add `--notify` if the
user authorizes the notice; omit it or use `--no-notify` to unbind silently.

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli channel unbind \
  --project <project_id> --task <task_id> --bot <bot_id> --group <group_id> --notify --json
```

The native `workstep_unbind_channel_group` takes `project_id`, `task_id`,
`bot_id`, `group_id`, optional `notify` (boolean), and `confirm='yes'`.
The daemon removes the binding first and sends a fixed notice only to that
group. Check `notification`: `sent` means the send succeeded, `failed` means
the send did not succeed but the group remains unbound, and `skipped` means
there was no matching binding to remove. Report the unbinding and notice
outcomes separately. Do not use `channel send` for a second confirmation, and
do not repeat the unbind to retry a failed notice. For archiving, see
[Tasks](tasks.md#task-lifecycle-and-archive-experience).


## Channel images and files

`channel send` accepts repeatable `--image <local_path>` and `--file <local_path>`
alongside optional `--text`. At least one text/image/file is required; the same
session or bot/user/group selectors and authorization rules apply. The CLI
uploads local files through the daemon into project uploads, then sends the
project-relative references using the unified channel protocol:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli channel send \
  --project <project_id> --session <session_id> --image /path/to/screenshot.png --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli channel send \
  --project <project_id> --bot <bot_id> --user <user_id> --text "Report" --file /path/to/report.pdf --json
```

WorkStep currently limits images to 2 MiB and files to 20 MiB, with at most 10
attachments per send. DingTalk native files support xlsx/pdf/zip/rar/doc/docx;
unsupported file types return an error. Platform permissions and quotas still
apply. Native callers can use `workstep_upload_channel_attachment` with
`project_id/filename/data_url/confirm='yes'`, then pass
`attachments: [{kind: 'image'|'file', path: '<returned project URL>'}]` to
`workstep_send_channel_message`. Attachment-only sends do not require text.

