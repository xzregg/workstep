## Engines

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli engine list --json
```


Use returned engine IDs and capability/installed/configured/enabled fields; do not
infer IDs from display names. Discover model IDs in the target project's context:

```bash
workstep engine models --engine <engine_id> --project <project_id> --refresh --json
workstep engine models --engine <engine_id> --project <project_id> --provider <provider_id> --json
```

Native: `workstep_list_engine_models` with `engine_id`, optional `project_id`,
`provider_id`, and `refresh`. Without refresh, native models come from cache;
with a provider they come from its saved model selection. Check `error` and an
empty model directory before choosing. Project-scoped identities cannot refresh
the host directory. These catalogs are candidates, not verified delegation choices. For delegation,
use `digital-hub delegate-options --project <project_id> --json` and optionally
`--target-session <execution_session_id>`. Only `delegate-verify --project
<project_id> --engine <engine_id> --model <model_id>` can add a combination after
two actual toolless turns with actual-model confirmation; it may incur usage and
requires authorization to test. Missing evidence means temporarily unsupported.

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
