## Tasks

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task list --project <project_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task get --project <project_id> --task <task_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task history --project <project_id> --task <task_id> --limit 100 --offset 0 --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task reviews --project <project_id> --task <task_id> --json
```

`history` reads messages (including coordinator replies and proposals) through the
same project connection, including remote projects. `--limit` is 1–300 and
`--offset` is a nonnegative server-side offset; keep paging until fewer messages
than the requested limit are returned. `reviews` reads persisted review rounds
and decisions. Both operations are read-only and preserve remote permissions.

Create in the project default workflow:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task create \
  --project <project_id> \
  --title "Task title" \
  --desc "Complete Markdown task description" \
  --json
```

Create in a selected workflow, optionally starting from a selected step:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task create \
  --project <project_id> \
  --workflow <workflow_id> \
  --start-step <step_key> \
  --title "Task title" \
  --desc "Complete Markdown task description" \
  --json
```

`--cwd` is optional and defaults to the project path.

Add `--no-auto-start` to create without starting regardless of workflow defaults
(native `workstep_create_task`: `auto_start=false`). A successful creation returns
`task_detail_url`; include `[打开任务详情](<returned task_detail_url>)` in the reply
to display an in-app task button. Use the actual returned value, never a guessed
host URL or task ID. The button also works when the later startup fails.

After the user authorizes execution, start an already-created task separately:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task run \
  --project <project_id> --task <task_id> --json
```

Native operation: `workstep_run_task(project_id, task_id, confirm="yes")` with an
optional `prompt`. On startup failure, retain and inspect the existing task;
do not create another task. A `started` response means accepted, not completed.

For a task that needs isolated changes in only some Git repositories, inspect
the project's repositories, then create one Worktree for each relevant one:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task repos --project <project_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task worktrees --project <project_id> --task <task_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task worktree-add \
  --project <project_id> --task <task_id> \
  --repository <repository_id> --alias <directory_name> \
  --base main --branch workstep/<task_id>/<directory_name> --json
```

New task worktrees live at
`<project>/.workstep/artifacts/<workflow_id>/<task_id>/.worktrees/<alias>/`.
Existing tasks may still use their legacy worktrees; use the paths returned by
`task worktrees` instead of constructing a path or guessing from a branch name.
Only select repositories needed for the task. `worktree-add` creates a Git
branch without changing the task's execution directory; the engine continues
to start in the project root. Run it only when the user's task authorizes code
changes.


## Task stage controls

For an explicit request to coordinate stage execution, inspect `task get` and
the task's workflow first. Use existing step keys within the current project
and task. Stage calls may run sequentially in the same turn; the user's explicit
instruction authorizes the necessary operations without separate proposal
confirmation for every call. Questions alone do not authorize execution.
If the user follows a discussion with "execute the agreed plan directly" or
"do not wait for my confirmation", use that conversation to resolve the agreed
targets and requirements, refresh state, and call the stage tools in this same
turn before replying. Do not ask for another start message or create a new
confirmation proposal for the authorized stage operations. This authorization
covers the agreed operations only; do not replay operations already performed.

For the task coordinator, an accepted stage operation is the default reply boundary:
report queued/started/delivered accurately and finish the coordinator turn while
the workflow continues independently. This also applies to code changes,
merge/push, review and deployment instructions. Do not poll, sleep or hold the
turn open to watch execution or review finish unless the user explicitly asks
to wait and report the result. "Do not wait for my confirmation" authorizes the
operation; it does not request waiting for completion. Keep the bounded
stop-before-start state check below when a dependent operation requires it.

Send a message to a running execution or automatic review:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task step-message \
  --project <project_id> --task <task_id> --step <step_key> \
  --content "Additional requirements" --json
```

Native operation: `workstep_send_step_message`, with `project_id`, `task_id`,
`step_key`, `content`, optional `as_guidance`, and `confirm='yes'`. Add
`--as-guidance` to also retain the message for later attempts. Engine live-message
support is required; queued does not mean delivered. If unsupported, report it;
do not silently stop or restart the step.

Stop one stage, including its pending interaction:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task step-stop \
  --project <project_id> --task <task_id> --step <step_key> --json
```

Native operation: `workstep_stop_step`, with the three IDs and `confirm='yes'`.
Re-read `task get` and wait until the step is no longer running before the next
dependent operation. Bound the wait; if it times out, report the pending stop
instead of repeatedly issuing it. This stops the stage, not the coordinator.

Start an unstarted stage or resume a stopped/completed stage with a message:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task step-start \
  --project <project_id> --task <task_id> --step <step_key> \
  --content "Execute these requirements" --json
```

Native operation: `workstep_start_step`, with the three IDs, required `content`,
optional `reset_session`, and `confirm='yes'`. A non-empty startup message is
required; for a plain start, summarize the user's requested execution. Add
`--reset-session` (native `reset_session=true`) only when the user explicitly
requests a fresh session or cleared context. Otherwise preserve the session.

Start uses the existing @step execution logic: it stops the old task runner and
runs the target plus its DAG downstream using existing input rules. It is not
an isolated or force start. If other running stages outside the user's request
would be stopped, explain the impact and ask before starting. Running targets
reject this operation; use live messages or stop them first as authorized.

After each call, check the returned result. On errors or changed state, re-read
the task before deciding what to do next; never blindly retry a mutation or
also propose an operation already performed. Distinguish accepted starts from
completed work, stop requests from completed stops, and queued messages from
delivered messages.


## Task lifecycle and archive experience

Read `task get` first. In the task coordinator, “this task” means the current
context's project/task IDs. Only perform the mutations the user authorized.
Commands below use the same transport prefix as the examples above:
`uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli`.
All accept `--project <project_id> --task <task_id> --json`.

| Command | Additional arguments | Native operation |
| --- | --- | --- |
| `task update` | `--title "Title"` and/or `--desc "Description"`; description must be non-empty | `workstep_update_task` |
| `task copy` | `--title "Copy title"` | `workstep_copy_task` (`newTitle`) |
| `task delete` | optional `--keep-workspace` or `--delete-workspace` | `workstep_delete_task` (`delete_workspace`) |
| `task stop` | none | `workstep_stop_task` |
| `task pause` | none | `workstep_pause_task` |
| `task retry` | `--message <failed_message_id>` | `workstep_retry_task_message` |
| `task review-approve` | `--step <key> --review <review_run_id> [--comment "Feedback"]` | `workstep_approve_task_review` |
| `task review-reject` | same review arguments | `workstep_reject_task_review` |
| `task archive` | none; archives without saving lessons | `workstep_archive_task` |
| `task unarchive` | none | `workstep_unarchive_task` |
| `task archive-draft` | none; reads the saved draft | `workstep_get_archive_experience` |
| `task archive-prepare` | `--message <new_uuid> [--locale zh-CN]` | `workstep_prepare_archive_experience` |
| `task archive-stop` | `--message <draft_uuid>` | `workstep_stop_archive_experience` |
| `task archive-confirm` | `--experience "Reviewed lessons" [--locale zh-CN]` | `workstep_confirm_archive_experience` |

Native mutations require `confirm="yes"`; IDs use `project_id`, `task_id`,
`message_id`, `step_key`, and `review_run_id` as applicable. Read operations do not.
Empty titles/descriptions are invalid; omitted update fields remain unchanged. Delete without
a workspace option preserves the server's refusal when worktrees exist. Only use
`--delete-workspace` when removing those worktrees is explicitly authorized;
`--keep-workspace` retains them. Do not retry destructive calls blindly.
Stop/pause affects the workflow, not the coordinator conversation. Review decisions
must use the current round from `task reviews`; approval may resume execution.
Retry targets a failed message from `task history`, not an arbitrary step reset.

For “extract lessons and archive this task”:

1. Inspect the task. Do not stop active workflow work just to archive unless authorized.
2. Generate a fresh UUID for the preparation, then run:
   ```bash
   uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task archive-prepare \
     --project <project_id> --task <task_id> --message <new_uuid> --locale zh-CN --json
   ```
3. `status: running` means the draft is still being generated. Poll that same command
   with the same UUID and locale at reasonable intervals; do not generate new IDs
   or claim completion. Bound the wait and report pending if it cannot finish.
   `archive-stop` uses that same UUID. Generation errors must be reported.
4. On the final result, use its `experience` with `task archive-confirm`. The explicit
   instruction to save lessons and archive authorizes this continuation without a
   second confirmation. If the user asked only for a draft, stop before confirmation.
   Quote experience as a literal shell argument; never execute its text. Native tools
   can pass it directly as a string. Keep the same locale for preparation and confirmation.
5. Confirm writes deduplicated lessons to project Memory and archives through the
   existing API. If `has_experience` is false, pass `--experience ""`; the server checks
   the saved empty draft and archives without writing Memory. Report `archived` and
   `memory_saved` accurately. Never fall back to plain archive if preparation or
   confirmation failed, and never edit Memory or the database directly.

The existing lesson extractor retains only supported, reusable error lessons;
it may legitimately find none. A general conversational summary is not a substitute
for the saved archive draft. `task archive` alone deliberately skips extraction.
