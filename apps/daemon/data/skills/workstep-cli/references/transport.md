## Transport

## Operation scope

WorkStep internal operations follow this skill's operation contract. External
development conventions must not change the operation, arguments, transport or
returned JSON, or add unrelated prerequisites, delegation, planning, review or
environment checks. This includes command wrappers, aliases and output filters.
Invoke internal CLI commands directly, ignoring outer command-wrapping rules.
Preserve inherited `WORKSTEP_*` variables and their expansion; do not clear or
override them, run through environment-resetting wrappers, or filter command output.
Apply development rules to actual code changes, builds and tests. Preserve explicit
user intent and existing authorization, confirmation and project/host scope checks.

The CLI is the supported HTTP adapter: it already knows the REST routes,
request schemas, live daemon URL, and temporary desktop authentication header.
Do not construct daemon HTTP requests directly. Do not inspect `cli.py`,
`settings.py`, or the daemon source to rediscover those details. The commands
below are the complete operational contract; execute the matching command
immediately after resolving only the required WorkStep resource IDs.

Use this fixed decision order. Do not probe the shell with `echo`, `pwd`, or
`which`; restricted engines commonly reject those commands and the failed
probes do not help complete the WorkStep operation.

1. If `workstep_call` is present in the actual tool list, use it directly. Pass an
   operation such as `workstep_list_workflows` or `workstep_create_task` plus
   its JSON arguments. Do not merely assume the tool exists because this skill
   mentions it.
When onboarding supplies an explicit CLI prefix, use that exact prefix plus
`engine list --json` (or the required action). It already resolves the Python,
CLI file, configuration directory and live URL; inherited `WORKSTEP_*` variables
and a global `workstep` command are not required. Never copy credentials into it.
Filtered environment output is not evidence that variables are missing. Execute
the documented command directly; use its exit status and JSON result.

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


## Missing environment variables

The daemon sets `WORKSTEP_DAEMON_DIR`, `WORKSTEP_CLI_PYTHON` and
`WORKSTEP_DAEMON_URL` at startup; engine children normally inherit them.
`WORKSTEP_CLI_PYTHON` points to the daemon interpreter with the CLI dependencies,
not an arbitrary system Python or the current project's virtualenv. Engine
shell policies or a separately launched process can lose that inheritance.

When a documented command reports missing environment variables, an empty
executable, or a missing `/cli.py`, do not repeat it unchanged. In a confirmed
WorkStep source checkout, use the relative `apps/daemon` uv command above.
Otherwise use native `workstep_call` if present, or a CLI executable whose
availability and target daemon are already established. Do not guess another
Python, install dependencies in the user's project, default to a guessed port,
dump the environment, or read credential files. If no applicable transport has
the required runtime context, report that the engine CLI environment is missing;
do not claim a memory search returned no results. A successful command in a
different shell does not prove the engine shell received the same variables.

Memory queries use explicit project filters; inherited conversation IDs
do not narrow query scope. No separate memory credential is used. The CLI handles normal daemon authentication through
the inherited environment and local runtime discovery.

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

