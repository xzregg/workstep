## Engines

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli engine list --json
```


## Custom skill drafts

Use the Transport above with `skill create --json` to start an ordinary conversation in the fixed `Runtime` project root; no per-type or per-session directory is allocated. The native operation is `workstep_create_skill_draft` with `confirm='yes'`. Read the returned `prompt`, `workspace_path` and `package_path`; create a named skill package within that root without overwriting other existing work. This operation neither installs nor enables a skill. Existing installed skill roots remain unchanged, and draft directories are not skill discovery roots. Install only when explicitly requested by the user.


## Custom engines

When creating or updating a custom engine, read [the onboarding guide](custom-engine.md) and [adapter contract](custom-engine-contract.md) on demand. These are reference documents within this CLI skill; do not load a separate custom-engine skill. Commands accept an absolute package directory or its Python entry file.

```bash
workstep engine inspect /absolute/adapter --json
workstep engine install /absolute/adapter --json
workstep engine configure /absolute/adapter --config-file /private/config.json --json
workstep engine validate /absolute/adapter --json
workstep engine register /absolute/adapter --json
workstep engine register /absolute/adapter --replace --json
workstep engine export engine_id --output /absolute/engine.zip --json
workstep engine disable engine_id --json
workstep engine enable engine_id --json
workstep engine rollback engine_id --json
```

Install/validate wait for the final result. Add `--no-wait` to get an operation ID, query with `engine operation ID --json`, or cancel with `engine stop ID --json`. A passed report is bound to code, dependencies and configuration; changes require validation again. Registration is atomic and requires a daemon restart to discover the new adapter. Export excludes dependencies and credentials; recipients reinstall for their own OS/architecture. Visibility switches only hide engines in selectors; `disable` actually prevents custom engine execution.



## Custom skins

For conversational skin creation, read [references/custom-skin.md](custom-skin.md)
and the workspace `skin-contract.json`. Use the transport above with:

```bash
workstep skin list --json
workstep skin contract --json
workstep skin validate /absolute/skin --json
workstep skin register /absolute/skin --json
workstep skin register /absolute/skin --replace --json
workstep skin export ocean --output /absolute/ocean.zip --json
```

Skins are declarative packages; business events stay in the application. Explicit
replacement requires the user's update instruction. A passing format check does
not imply visual acceptance; preview both PC and mobile in Settings → Skins.
