## Schedules

### Act later in the current conversation

When the user explicitly asks to check, remind, or act later in this conversation,
create a session schedule only after the target WorkStep project and conversation
are known. First run `context get --json` using the CLI transport below. It reads
`WORKSTEP_PROJECT_ID` and `WORKSTEP_SESSION_ID` from this execution environment,
returning `project_id` and `session_id` without adding metadata to chat prompts.
These are WorkStep IDs, not engine thread IDs. Do not dump the full environment.

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli context get --json
```

Use the returned IDs for the current conversation. For a different target, resolve
that target explicitly. If context is unavailable, ask the user to identify the
target or use the conversation selector in the schedule page. Never guess from
the newest conversation or its title. Never claim creation without tool success.

Using the applicable transport from SKILL.md:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule create \
  --project <project_id> --target session --session <session_id> \
  --name "Follow-up" --instruction "Action to perform at that time" \
  --after 2h --idempotency-key <request_key> --json
```

Replace the example delay with the user's requested delay. `--after` is one-shot,
not `--every-minutes`. Use `--at` for an exact datetime with an explicit timezone.
Choose one request key per authorized creation and reuse it on retries to avoid
duplicates. No message ID is required.
Report success only after the CLI succeeds, including the returned execution time.
A channel conversation automatically sends the final reply to its original channel;
do not also send the same reply with `channel send`.
At execution time perform the requested action, do not schedule it again.


```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule list --project <project_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule get --project <project_id> --schedule <schedule_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule runs --project <project_id> --schedule <schedule_id> --json
```

Create a static recurring schedule:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule create \
  --project <project_id> \
  --workflow <workflow_id> \
  --name "Schedule name" \
  --title "Task title" \
  --desc "Task description" \
  --cron "0 9 * * *" \
  --timezone "Asia/Shanghai" \
  --execution workflow \
  --overlap skip \
  --json
```

Create a dynamic schedule whose task assistant selects candidate workflows
and creates one or more tasks per occurrence:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule create \
  --project <project_id> \
  --mode agent \
  --name "Dynamic schedule" \
  --instruction "Research today's sources and prepare one executable task" \
  --candidates <workflow_id_1>,<workflow_id_2> \
  --retry-count 2 \
  --cron "0 9 * * *" \
  --timezone "Asia/Shanghai" \
  --execution workflow \
  --overlap skip \
  --json
```

The instruction can request multiple tasks with independent creation parameters,
for example: "Create 5 tasks and start each tomorrow at 09:00, 10:00, 11:00,
14:00 and 15:00 Asia/Shanghai." The assistant returns `task_drafts`, using the
normal creation fields: `title`, `description`, `workflow_id`, `start_step_key`,
`cwd`, `engine`, `auto_start`, `review_overrides`, `scheduled_start_at`.
`scheduled_start_at` must be a future ISO timestamp with an explicit timezone;
it delays startup and cannot be combined with `auto_start: true`. Omitted
startup settings follow the schedule's execution mode. Creator identity comes
from the saved schedule. Run history exposes every created task in
`created_tasks`, with `task_id` retained as the first task for compatibility.
A creation failure retains earlier successes and does not rerun the batch.

Use `--at <ISO-date-time>` instead of `--cron` for a one-time schedule.
The timezone defaults to `UTC`; pass `--timezone Asia/Shanghai` (or another IANA name) for local clock-based rules. The CLI
accepts `--at`, five-field `--cron`, and `--every-minutes <1-10080>`; daily, weekly, monthly, and
interval rules are available through the native `workstep_call` operation/API.

Create a recurring instruction for an **existing task**, using the current task
ID from the conversation context (verify it with `task get`). Do not choose a
workflow or create a new task:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule create \
  --project <project_id> --target task --task <task_id> \
  --name "Progress report" --every-minutes 10 \
  --instruction "Summarize this task's progress, blockers and next steps; use the WorkStep CLI to send the report to the explicitly selected bound group." \
  --stop-condition manual --json
```

Task instructions are unrestricted text executed with the task coordinator's
normal capabilities and permissions. Each occurrence uses a fresh engine
session, concurrent with the main conversation; its instruction, response,
process and stop control appear in this task's history.

### Completion notifications

Task schedules with a bound group default to enabled and select that group.
Unbound task schedules and project schedules default to disabled. These defaults
are saved when creating the rule; explicit CLI settings override them. Existing
rules keep their previous disabled notification setting.

Inspect choices before selecting a destination:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule notification-options --project <project_id> --task <task_id> --json
```

Both `schedule create` and `schedule update` accept:

- `--no-notify`: disable the automatic notification.
- `--notify-session <session_id>`: enable and select a project channel session.
- `--notify-bot <bot_id> --notify-group <group_id>`: enable and select a project-bound group.
- `--notify`: enable using the bound task default (or an existing selected destination on update).

Do not combine a session with bot/group, or a target with `--no-notify`.
A project schedule notifies as soon as it successfully creates its task; it does
not wait for workflow completion. A task schedule sends the final coordinator
reply (or failure reason) when that occurrence finishes. Delivery failure is
recorded separately and does not rerun the task. Inspect `schedule runs` for
`notification_status`/`notification_error`; only `sent` confirms delivery.

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule update --project <project_id> --schedule <schedule_id> --notify-session <session_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule retry-notification --project <project_id> --schedule <schedule_id> --run <run_id> --json
```

The notification service handles the selected destination; do not also send the
same report through `channel send`. Use CLI sending for explicitly requested
additional/custom deliveries. A failed/removed destination never silently falls
back to a different group. Interrupted sends have an unknown result and require
checking the recipient before manual retry.

Use `--stop-condition task-terminal` only when asked to stop after the task
finishes; default `manual` continues until explicitly disabled. Archiving or
deleting the task invalidates its rules; restoring the task does not resume
them. Only `--overlap skip` is supported for task rules. Offline occurrences
are skipped; interrupted running instructions are not automatically replayed.
`--every-minutes` starts N minutes after creation/resume, anchored to that time.

Filter the shared management list with `schedule list --project <project_id>
--target task --task <task_id> --json`. Update the instruction with `schedule
update --project <project_id> --schedule <schedule_id> --instruction "..."`;
target IDs are immutable. Report the created rule ID and next execution time
from the actual CLI response. Task rule deletion preserves execution history.

Manage an existing schedule:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule update --project <project_id> --schedule <schedule_id> [fields] --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule pause --project <project_id> --schedule <schedule_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule resume --project <project_id> --schedule <schedule_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule delete --project <project_id> --schedule <schedule_id> --json
```

`--execution` accepts `workflow`, `immediate`, or `manual`. `--overlap` accepts
`skip`, `parallel`, or `queue`.


