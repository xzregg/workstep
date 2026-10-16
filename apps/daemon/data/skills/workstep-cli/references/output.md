## List output

All `list` commands return summaries by default. Add `--verbose` to retain the
full response. `--json` controls formatting only. Missing summary fields are
omitted; pagination metadata is preserved.

| Command | Default summary |
| --- | --- |
| `project list` | ID, name, path, type, connection status |
| `workflow list` | ID, name, default/deleted/running/failed flags, node count |
| `task list` | ID, title, status, archived flag, workflow ID, creation/update times |
| `engine list` | ID, installed/configured/verified/built-in flags, version, mode, default model |
| `schedule list` | ID, name, target type/task ID, workflow ID, status, rule summary, next/last run times |
| `channel list` | ID, name, platform, enabled flag, connection status |

Use `workflow get`, `task get`, or `schedule get` for one resource's details.
For example, `engine list --verbose --json` includes configuration forms and
capability declarations. Quick-button inspection returns full button settings
because prompts and scripts are the purpose of that command.


## Optional output controls

All `list` commands accept `--limit N` (positive) and `--offset N` (nonnegative).
These filter the CLI output locally; they do not reduce daemon reads or network traffic.
Defaults are unchanged: all returned items, with summary fields unless `--verbose`.
Explicit slicing reports `total` (matching items before slicing), `offset`, and
`remaining`. Array responses become `{items: [...], total, offset, remaining}`
only when slicing is requested; object responses keep their collection key.
Without slicing, upstream pagination metadata is preserved. Local task filters
update an existing `total` to the matching count.

All `list` and `get` commands accept `--fields id,name` to select resource
**top-level** fields from the full response, overriding summary/verbose fields.
Fields absent from a resource are omitted. Nested paths and empty names are
rejected. List envelope fields are preserved; errors are never projected.
`--json` emits compact JSON without separator spaces; ordinary output stays indented.

`task list` also accepts `--archived` (server-side, archived tasks only),
`--status <exact_status>` and `--workflow <workflow_id>` (local exact filters).
Filtering precedes slicing and field selection. Use the resource's real status.
`schedule runs` retains its existing server-side `--limit`/`--offset` behavior.

Resolve only the IDs needed for the user's request. Start with a small summary
page, read more when `remaining > 0`, then get the selected resource's details.
Do not describe a partial page as a complete search. Never use projected task or
workflow details to decide a stage mutation without reading the required full state.

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task list --project <project_id> --limit 20 --fields id,title,status --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task list --project <project_id> --workflow <workflow_id> --offset 20 --limit 20 --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli task get --project <project_id> --task <task_id> --fields id,title,status --json
```
