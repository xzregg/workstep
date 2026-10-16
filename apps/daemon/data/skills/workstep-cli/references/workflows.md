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
In coordinator chat, draft `create_workflow_action` as a proposal without writing
the script. Use a relative script filename, select worktrees by repository ID
or alias, and save their `relative_path` rather than a machine-specific `path`.
If input is required, include `confirmation_input_prompt` and read the supplied
text as `"$WORKSTEP_ACTION_INPUT"` without evaluating it. Service scripts should
print actual URLs, wait for children, and trap TERM/INT to stop the process group.

