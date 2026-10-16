## Projects

`project list` returns only `id`, `name`, `path`, `type`, and
`connection_status` when present. Add `--verbose` to retrieve the full project
payload, including workflow definitions and settings. `--json` controls output
formatting only; it does not change which fields are returned. Use
`workflow list` / `workflow get` for workflow summaries and details.

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

