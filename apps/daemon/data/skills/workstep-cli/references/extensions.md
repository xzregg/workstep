## Engines

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli engine list --json
```


## Custom skill drafts

Use the Transport above with `skill create --json` to start an ordinary conversation in the fixed `Runtime` project root; no per-type or per-session directory is allocated. The native operation is `workstep_create_skill_draft` with `confirm='yes'`. Read the returned `prompt`, `workspace_path` and `package_path`; create a named skill package within that root without overwriting other existing work. This operation neither installs nor enables a skill. Existing installed skill roots remain unchanged, and draft directories are not skill discovery roots. Install only when explicitly requested by the user.


## Custom engines

Read [the CLI workflow](custom-engine.md), [adapter contract](custom-engine-contract.md), and [test specification](custom-engine-testing.md) on demand. These are references within workstep-cli, not a separate skill. The workflow owns command examples, registration, import/export and recovery; the contract and tests own implementation and acceptance requirements.

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
