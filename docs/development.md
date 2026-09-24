# Development guide

## Setup

```bash
cd apps/daemon
uv sync --dev
uv run --no-sync uvicorn main:app --reload --port 8765
```

```bash
cd apps/web
corepack yarn install --frozen-lockfile
corepack yarn dev
```

The public landing page is in `apps/landing` and uses Yarn. Do not commit generated builds, local databases, logs, secrets, or personal configuration.
After installing an optional engine SDK in Settings, use `uv run --no-sync` to preserve it when restarting the daemon. Run `uv sync --dev` when you intentionally want to reset the project environment to the locked dependencies.

## Verification

```bash
cd apps/daemon && uv run --no-sync pytest
cd apps/web && corepack yarn test && corepack yarn build
cd apps/landing && corepack yarn test && corepack yarn build
python scripts/check_repository_health.py
```

Behavior changes should begin with a failing regression test. Frontend strings must exist in every locale with identical, non-empty key sets. New assistant capabilities reuse the shared runtime, stores, event channels, and chat components. Native `alert` and `confirm` are not used. Qoder stays optional and must not enter default, container, or desktop dependencies.

See [`AGENTS.md`](../AGENTS.md) for detailed agent-facing rules and [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the external contribution flow.
