---
name: workstep-cli
description: Inspect and manage WorkStep projects, workflows, tasks, quick buttons, engines, and schedules through the local daemon CLI or native WorkStep tools.
---

# WorkStep CLI

Use this skill when the user asks to inspect or manage WorkStep itself: projects,
workflows, tasks, quick buttons, LLM engines, or schedules.

## Transport

The CLI is the supported HTTP adapter: it already knows the REST routes,
request schemas, live daemon URL, and temporary desktop authentication header.
Do not construct daemon HTTP requests directly. Do not inspect `cli.py`,
`settings.py`, or the daemon source to rediscover those details. The commands
below are the complete operational contract; execute the matching command
immediately after resolving only the required WorkStep resource IDs.

Use this fixed decision order. Do not probe the shell with `echo`, `pwd`, or
`which`; restricted engines commonly reject those commands and the failed
probes do not help complete the WorkStep operation.

1. If `workstep_call` is present in the actual tool list, use it. Pass an
   operation such as `workstep_list_workflows` or `workstep_create_task` plus
   its JSON arguments. Do not merely assume the tool exists because this skill
   mentions it.
2. In a source checkout, prefer `uv`, which is allowed by WorkStep's restricted
   command policy. When the workspace is the WorkStep repository root, use:

```bash
uv run --no-sync --directory apps/daemon python -m cli <resource> <action> [options]
```

   From any project directory, use the injected daemon directory instead:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli <resource> <action> [options]
```

3. In a packaged desktop runtime, `uv` need not be installed. Use the bundled
   Python and CLI paths injected into the engine process:

```bash
"$WORKSTEP_CLI_PYTHON" "$WORKSTEP_DAEMON_DIR/cli.py" <resource> <action> [options]
```

   In PowerShell:

```powershell
& $env:WORKSTEP_CLI_PYTHON "$env:WORKSTEP_DAEMON_DIR/cli.py" <resource> <action> [options]
```

   In `cmd.exe`:

```bat
"%WORKSTEP_CLI_PYTHON%" "%WORKSTEP_DAEMON_DIR%\cli.py" <resource> <action> [options]
```

4. When the `workstep` executable is already known to be available, it is also
   valid:

```bash
workstep <resource> <action> [options]
```

Add `--json` to the selected action for compact machine-readable output. The
CLI automatically reads `WORKSTEP_DAEMON_URL` and the packaged desktop token
from its environment. Use `--url <daemon-url>` before the resource only for an
explicit override. Never write the runtime URL or authentication token into
this skill file or another persistent project file.

If a command-policy error rejects one transport, move directly to the next
applicable transport above. Do not spend turns testing unrelated shell
commands. If no listed transport is callable, report that the engine lacks a
WorkStep transport instead of claiming the requested mutation succeeded.

## First-run improvement

Try the documented transports first. Only when all applicable commands fail
may the first execution perform minimal exploration to find a working command.
Once a reusable command is verified by a successful JSON response, immediately
improve the canonical skill at
`$WORKSTEP_DAEMON_DIR/data/skills/workstep-cli/SKILL.md` when that file is
writable, so later sessions use the proven route without repeating discovery.

- Update the transport decision order and add one copy-pasteable example.
- Never edit generated copies under `.agents/skills` or `.workstep/skills`;
  WorkStep regenerates them from the daemon skill.
- Record only portable invocation details. Never persist temporary tokens,
  ports, resource IDs, project-specific paths, or returned user data.
- Preserve every working transport already documented; add a new alternative
  instead of replacing cross-platform fallbacks with one local workaround.
- In a source checkout, update the skill regression test when test tools are
  available. In a packaged/read-only runtime, report the verified improvement
  instead of attempting to modify bundled application files.

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

## Projects

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli project list --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli project init /absolute/project/path --name "Project name" --json
```

Read every project-level quick button (prompt, display, and Action), including
its title, content or prompt, Action script path, working-directory mode, and
confirmation setting:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli project quick-buttons \
  --project <project_id> --json
```

The equivalent native operation is `workstep_get_project_quick_buttons` with
`project_id`. This is read-only; it returns button settings, not script file
contents. Use it before proposing a new project button to avoid duplicates.

To create a project-wide Action shortcut, prepare a `.sh`, `.bash`, or `.py`
script file, show the script and button settings to the user, and wait for
explicit authorization. Then run:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli project action-create \
  --project <project_id> \
  --action-id <stable_action_id> --title "Restart services" \
  --script-file /absolute/path/to/restart.sh --cwd task --json
```

The equivalent native operation is `workstep_create_project_action` with
`project_id`, `action_id`, `title`, `script_path`, `script_content`,
`cwd_mode`, `require_confirmation`, and `confirm='yes'`. WorkStep saves the
script under `<project>/.workstep/actions/<action_id>/` and registers the
button in project settings. The button appears in project chats and can be
inherited by workflows. With `--cwd task` (the default), inherited task
Actions run in that task's artifact directory; in a project chat without a
task, they run at the project root. `--cwd project` always runs at the project
root. `--no-run-confirmation` only removes the later per-click confirmation;
it does not remove the authorization required to create the shortcut.

For an Action that needs one text value at execution time, add
`--input-prompt "Enter Commit message"` (or native
`confirmation_input_prompt`). The confirmation dialog then requires text and
passes it unchanged in `WORKSTEP_ACTION_INPUT`. Shell scripts must always read
it as `"$WORKSTEP_ACTION_INPUT"`; never interpolate it into generated shell
syntax or execute it with `eval`. For example:

```bash
git commit -m "$WORKSTEP_ACTION_INPUT" && git push
```

## Workflows

List workflows to resolve the target workflow ID:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli workflow list --project <project_id> --json
```

Read the full workflow, including step definitions and step keys:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli workflow get \
  --project <project_id> \
  --workflow <workflow_id> \
  --json
```

To inspect shortcut buttons without reading the full canvas, use:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli workflow quick-buttons \
  --project <project_id> --workflow <workflow_id> --json
```

The result separates workflow-level buttons, stage-level buttons (with step
keys), and project buttons actually inherited by this workflow. It also
includes `project_button_ids`; an empty list means none are selected, while
`inherit_all_project_buttons: true` means the legacy all-project mode. Native
tools can obtain the same data by calling `workstep_get_workflow` and
`workstep_get_project_quick_buttons`, then matching the workflow's
`projectQuickButtonIds` (or legacy `inheritProjectQuickButtons`) to project
button IDs. These read-only calls return button settings, not Action script
contents. Inspect existing buttons before suggesting or creating another one.

To create a workflow Action shortcut, first inspect the target workflow and
relevant task repositories/worktrees. Prepare a `.sh`, `.bash`, or `.py` script
file and show its contents and button settings to the user. After explicit
authorization, publish the script and button together:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli workflow action-create \
  --project <project_id> --workflow <workflow_id> \
  --action-id <stable_action_id> --title "Start services" \
  --script-file /absolute/path/to/start.sh --cwd task \
  --input-prompt "Enter Commit message" --json
```

The equivalent native operation is `workstep_create_workflow_action` with
`project_id`, `workflow_id`, `action_id`, `title`, `script_path`,
`script_content`, `cwd_mode`, `require_confirmation`, optional
`confirmation_input_prompt`, optional `overwrite`,
and `confirm='yes'`.
The CLI performs the confirmation-gated call; do not call it merely to draft
a suggestion. `--no-run-confirmation` removes the *later* per-click dialog,
not the authorization required to create the shortcut. WorkStep writes the
script under `.workstep/artifacts/<workflow_id>/actions/<action_id>/` and
registers the workflow button. A task coordinator can instead return a
`create_workflow_action` proposal so the user can review and confirm it in chat.
If `workflow quick-buttons` shows an Action with the same `action_id`, do not
create a duplicate or silently replace it. Read its existing button settings
and script, show the proposed changes, and obtain explicit approval to replace
it. Then reuse that `action_id` and script filename and add `--overwrite` to
the `workflow action-create` command (or `overwrite: true` to the native call
or coordinator proposal). Without this flag, a duplicate remains a conflict;
the flag never replaces a prompt/display button with the same ID.
Do not claim the shortcut exists before the write succeeds. Scripts should resolve task worktrees via
`WORKSTEP_WORKTREES_FILE` using repository IDs or aliases, never branch names.
For stoppable services, keep children in the Action process group and wait for
them; avoid `nohup`, `setsid`, `disown`, or daemonizing them.

## Tasks

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task list --project <project_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task get --project <project_id> --task <task_id> --json
```

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

## Engines

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli engine list --json
```

## Schedules

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

Create a dynamic schedule whose task assistant selects one candidate workflow
and creates one task per occurrence:

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

Use `--at <ISO-date-time>` instead of `--cron` for a one-time schedule. The CLI
currently accepts `--at` and five-field `--cron`; daily, weekly, monthly, and
interval rules are available through the native `workstep_call` operation/API.

Manage an existing schedule:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule update --project <project_id> --schedule <schedule_id> [fields] --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule pause --project <project_id> --schedule <schedule_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule resume --project <project_id> --schedule <schedule_id> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli schedule delete --project <project_id> --schedule <schedule_id> --json
```

`--execution` accepts `workflow`, `immediate`, or `manual`. `--overlap` accepts
`skip`, `parallel`, or `queue`.


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
