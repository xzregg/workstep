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
